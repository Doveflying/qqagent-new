/**
 * 扫码登录服务
 *
 * 为什么需要它：NapCat 登录时把二维码写成文件（cache/qrcode.png），原来的
 * repair-login.ps1 等它出现后直接 Start-Process 在**本机桌面**弹一个图片窗口——
 * 人必须坐在那台电脑前才能扫。这里把同一份二维码通过面板 HTTP 接口暴露出去，
 * 于是任何能打开面板的设备（手机、另一台电脑）都能看到并扫码。
 *
 * 三件事：
 *  1. qr()        读 NapCat 的二维码文件，给出新鲜度（面板据此决定显不显示）
 *  2. png()       把二维码原样吐给 HTTP
 *  3. startRepair() 拉起 scripts/repair-login.ps1（-NoOpen），输出重定向到
 *     runtime/login-repair.log，面板轮询日志展示进度
 *
 * NapCat 安装目录的定位顺序（前者优先）：
 *   QQ_AGENT_NAPCAT_DIR 环境变量 → speech.allowedDirs 里指向的 cache 目录 →
 *   常见安装路径（C:\napcat 等）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { AppConfig } from '../core/types.js';
import { PROJECT_ROOT } from '../config/loader.js';

export interface QrFileState {
  path: string;
  /** 二维码来自宿主机文件，还是 NapCat 容器内部（云端） */
  source: 'file' | 'docker';
  exists: boolean;
  /** 文件修改时间（ms），0 表示不存在 */
  mtimeMs: number;
  /** 距今多少毫秒；文件不存在时为大数 */
  ageMs: number;
  bytes: number;
}

export interface RepairState {
  running: boolean;
  startedAt: number | null;
  killQQ: boolean;
  logPath: string;
}

export interface LoginService {
  napcatDir: string;
  qr(): QrFileState;
  png(): Buffer | null;
  repairState(): RepairState;
  repairLog(limit?: number): string;
  startRepair(opts?: { killQQ?: boolean }): { ok: boolean; error?: string };
  /** 面板可从哪些地址打开（含本机回环与局域网），用于手机访问 */
  panelUrls(
    host: string,
    port: number,
  ): Array<{ label: string; url: string; loopback: boolean; reachable: boolean }>;
}

function candidateDirs(cfg: AppConfig): string[] {
  const isWin = process.platform === 'win32';
  const out: string[] = [];
  if (process.env.QQ_AGENT_NAPCAT_DIR) out.push(process.env.QQ_AGENT_NAPCAT_DIR);

  // speech.allowedDirs 里通常已经写了 C:/napcat/cache —— 反推安装目录。
  // 注意：云端 app.yaml 是从本机带过去的，Linux 上这些 C:/ 路径没意义，
  // 直接 path.resolve 会得到 /opt/qqagent/C:/napcat 这种鬼东西，必须跳过。
  for (const dir of cfg.speech?.allowedDirs ?? []) {
    if (!isWin && /^[A-Za-z]:[\\/]/.test(dir)) continue;
    const norm = path.resolve(dir);
    out.push(path.basename(norm).toLowerCase() === 'cache' ? path.dirname(norm) : norm);
  }

  if (isWin) out.push('C:\\napcat', 'C:\\NapCat', 'D:\\napcat');
  out.push(path.join(os.homedir(), 'napcat'), path.join(os.homedir(), 'NapCat'));
  if (!isWin) out.push('/opt/napcat', '/opt/napcat/cache');
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function pickNapcatDir(cfg: AppConfig): string {
  const dirs = candidateDirs(cfg);
  // 先找已经有二维码文件的
  for (const dir of dirs) {
    const cache = path.join(dir, 'cache');
    try {
      if (!fs.existsSync(cache)) continue;
      const names = fs.readdirSync(cache);
      if (names.some((n) => /^qrcode.*\.png$/i.test(n))) return dir;
    } catch {
      /* 权限等问题跳过 */
    }
  }
  // 再退一步：只要有 cache 目录（登录前二维码还没生成）
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, 'cache'))) return dir;
    } catch {
      /* 跳过 */
    }
  }
  // 都找不到时退到默认安装路径（后续会提示二维码不存在）
  return dirs[0] ?? 'C:\\napcat';
}

function newestQrPath(napcatDir: string): string {
  const cache = path.join(napcatDir, 'cache');
  const plain = path.join(cache, 'qrcode.png');
  try {
    const names = fs
      .readdirSync(cache)
      .filter((n) => /^qrcode.*\.png$/i.test(n))
      .map((n) => path.join(cache, n))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const newest = names[0];
    if (newest) return newest.p;
  } catch {
    /* cache 目录还不存在 */
  }
  return plain;
}

// ---------------------------------------------------------------- 容器模式
// 云端（Linux）的 NapCat 跑在 docker 里，二维码在容器内部，宿主机看不到文件。
// 用 `docker exec` 把 PNG 和 mtime 取出来；容器名可用环境变量覆盖。
const DOCKER_CONTAINER = process.env.QQ_AGENT_NAPCAT_CONTAINER || 'napcat';
const DOCKER_QR_PATH = '/app/napcat/cache/qrcode.png';
const DOCKER_TTL_MS = 2000;

interface DockerCache {
  bytes: Buffer | null;
  mtimeMs: number;
  at: number;
}

function runSync(cmd: string, args: string[], timeout = 8000): Buffer | null {
  try {
    const r = spawnSync(cmd, args, { timeout, maxBuffer: 8 << 20, windowsHide: true });
    if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

function dockerQrMtime(): number {
  const out = runSync('docker', ['exec', DOCKER_CONTAINER, 'stat', '-c', '%Y', DOCKER_QR_PATH]);
  if (!out) return 0;
  const secs = Number(out.toString().trim());
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

export function createLoginService(cfg: AppConfig): LoginService {
  const napcatDir = pickNapcatDir(cfg);
  const logPath = path.join(PROJECT_ROOT, 'runtime', 'login-repair.log');
  let child: ChildProcess | null = null;
  let startedAt: number | null = null;
  let lastKillQQ = false;
  const dockerCache: DockerCache = { bytes: null, mtimeMs: 0, at: 0 };

  /** 容器里的二维码（带 2s 缓存：面板每 2.5s 轮一次，不必每次都 docker exec） */
  const dockerQr = (): DockerCache => {
    if (Date.now() - dockerCache.at < DOCKER_TTL_MS) return dockerCache;
    const bytes = runSync('docker', ['exec', DOCKER_CONTAINER, 'cat', DOCKER_QR_PATH]);
    dockerCache.bytes = bytes && bytes.length > 8 ? bytes : null;
    dockerCache.mtimeMs = dockerCache.bytes ? dockerQrMtime() : 0;
    dockerCache.at = Date.now();
    return dockerCache;
  };


  const alive = (): boolean => {
    if (!child || child.pid == null || child.exitCode != null) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    napcatDir,

    qr(): QrFileState {
      const p = newestQrPath(napcatDir);
      try {
        const st = fs.statSync(p);
        if (st.size > 8) {
          return {
            path: p,
            source: 'file',
            exists: true,
            mtimeMs: st.mtimeMs,
            ageMs: Date.now() - st.mtimeMs,
            bytes: st.size,
          };
        }
      } catch {
        /* 宿主机没有二维码文件 -> 试容器 */
      }
      // 云端：二维码在 NapCat 容器里
      const d = dockerQr();
      if (d.bytes) {
        return {
          path: `docker:${DOCKER_CONTAINER}${DOCKER_QR_PATH}`,
          source: 'docker',
          exists: true,
          mtimeMs: d.mtimeMs,
          ageMs: d.mtimeMs ? Date.now() - d.mtimeMs : Number.MAX_SAFE_INTEGER,
          bytes: d.bytes.length,
        };
      }
      return {
        path: p,
        source: 'file',
        exists: false,
        mtimeMs: 0,
        ageMs: Number.MAX_SAFE_INTEGER,
        bytes: 0,
      };
    },

    png(): Buffer | null {
      const p = newestQrPath(napcatDir);
      try {
        const buf = fs.readFileSync(p);
        if (buf.length > 8) return buf;
      } catch {
        /* 落到容器 */
      }
      return dockerQr().bytes;
    },

    repairState(): RepairState {
      const running = alive();
      if (!running && child && child.exitCode != null) child = null;
      return { running, startedAt, killQQ: lastKillQQ, logPath };
    },

    repairLog(limit = 4000): string {
      try {
        const text = fs.readFileSync(logPath, 'utf8');
        return text.length > limit ? text.slice(-limit) : text;
      } catch {
        return '';
      }
    },

    startRepair(opts = {}) {
      if (alive()) return { ok: false, error: '已经有一个扫码登录流程在跑，请等它结束' };

      // Windows：本机 NapCat（文件 + powershell 修复脚本）
      // Linux：云端 NapCat 在 docker 里，重启容器 → 没有快速登录令牌 → 必然出二维码
      const isLinux = process.platform === 'linux';
      const script = path.join(
        PROJECT_ROOT,
        isLinux ? 'deploy' : 'scripts',
        isLinux ? 'relogin.sh' : 'repair-login.ps1',
      );
      if (!fs.existsSync(script)) return { ok: false, error: `找不到 ${script}` };

      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      let fd: number;
      try {
        fd = fs.openSync(logPath, 'w');
      } catch (e) {
        return { ok: false, error: `无法写日志 ${logPath}: ${(e as Error).message}` };
      }

      const file = isLinux ? 'bash' : 'powershell.exe';
      const args = isLinux
        ? [script, DOCKER_CONTAINER]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NapCatDir', napcatDir, '-NoOpen'];
      if (!isLinux && opts.killQQ) args.push('-KillQQ');

      try {
        child = spawn(file, args, {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        });
      } catch (e) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 已关闭 */
        }
        return { ok: false, error: `启动失败: ${(e as Error).message}` };
      }

      // 句柄已被子进程继承，父进程不再需要
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭 */
      }

      startedAt = Date.now();
      lastKillQQ = Boolean(opts.killQQ);
      child.on('exit', () => {
        child = null;
      });
      return { ok: true };
    },

    panelUrls(host: string, port: number) {
      const loopbackHosts = ['127.0.0.1', 'localhost', '::1'];
      const boundLoopback = loopbackHosts.includes(host);
      const urls: Array<{ label: string; url: string; loopback: boolean; reachable: boolean }> = [
        { label: '本机', url: `http://127.0.0.1:${port}/`, loopback: true, reachable: true },
      ];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family !== 'IPv4' || a.internal) continue;
          urls.push({
            label: `局域网 · ${name}`,
            url: `http://${a.address}:${port}/`,
            loopback: false,
            // 面板只绑回环时，局域网地址其实连不上
            reachable: !boundLoopback,
          });
        }
      }
      return urls;
    },
  };
}

/** NapCat 二维码一般 2 分钟失效；超过这个时间就不建议再扫 */
export const QR_FRESH_MS = 120_000;
