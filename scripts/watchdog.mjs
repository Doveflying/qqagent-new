// 看门狗：检测"端口还在、但 QQ 已经断线"这种假在线状态。
//
// 为什么需要：NapCat 的 get_status 返回 online=false 时，进程、WebSocket 端口、
// get_login_info 缓存都还正常，Agent 的 /api/health 也报 connected=true。
// 光看端口或账号信息根本发现不了，实际表现就是"显示登录、但消息石沉大海"。
//
// 用法：
//   node scripts/watchdog.mjs            检查一次（调度循环里每 10 分钟跑）
//   node scripts/watchdog.mjs --verbose  每次都打印，不只在状态变化时

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'watchdog.json');
const STATE_PATH = path.join(REPO, 'config', 'watchdog.state.json');
const LOG_PATH = path.join(REPO, 'logs', 'watchdog.log');

const VERBOSE = process.argv.includes('--verbose');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  try { fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); } catch {}
}
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8'); } catch {}
}

/** 询问 NapCat：返回 { online, login } 或 { error }。 */
function probe(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return done({ error: String(e?.message ?? e) }); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ error: 'timeout' }); }, timeoutMs);

    const out = {};
    let got = 0;
    const collect = () => {
      if (++got < 2) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      done(out);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'login' }));
      ws.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'status' }));
    };
    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.echo === 'login') { out.login = d.data ?? d.message; collect(); }
      if (d.echo === 'status') { out.status = d.data ?? d.message; collect(); }
    };
    ws.onerror = () => { clearTimeout(timer); done({ error: 'connect-failed' }); };
  });
}

async function agentAlive(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const doc = await r.json();
    return doc?.runtime?.onebot?.connected === true;
  } catch {
    return false;
  }
}

async function main() {
  const cfg = readJson(CFG_PATH, {
    onebotUrl: 'ws://127.0.0.1:3001',
    agentUrl: 'http://127.0.0.1:3081',
    offlineThreshold: 3,
    autoRestart: false,
    napcatLauncher: 'C:\\napcat\\headless-napcat.bat',
  });
  const state = readJson(STATE_PATH, { consecutiveOffline: 0, lastState: '' }) ?? {};

  const result = await probe(cfg.onebotUrl);
  const agentOk = await agentAlive(cfg.agentUrl);

  let status;      // 'online' | 'offline' | 'down'
  let detail = '';
  if (result.error) {
    status = 'down';
    detail = `NapCat 无法连接（${result.error}）`;
  } else if (result.status?.online === true) {
    status = 'online';
    detail = `账号 ${result.login?.user_id ?? '?'} 在线`;
  } else {
    status = 'offline';
    detail = `账号 ${result.login?.user_id ?? '?'} 已断线（online=false），进程和端口仍正常`;
  }

  // 连续计数：只有 offline 才累加，其余清零
  state.consecutiveOffline = status === 'offline' ? Number(state.consecutiveOffline ?? 0) + 1 : 0;

  const changed = state.lastState !== status;
  if (changed || VERBOSE) {
    logLine(`${status.toUpperCase()} ${detail} | agent=${agentOk ? 'ok' : 'DOWN'} | 连续断线=${state.consecutiveOffline}`);
  }

  if (status !== 'online' && !agentOk) {
    logLine('提示：Agent 没有在运行，双击桌面的 QQ Agent 启动');
  }

  const threshold = Number(cfg.offlineThreshold ?? 3);
  if (status === 'offline' && state.consecutiveOffline >= threshold) {
    logLine(`[!] 已连续 ${state.consecutiveOffline} 次检测到断线。NapCat 显示登录但不工作，需要重新登录。`);
    if (cfg.autoRestart) {
      logLine(`[!] autoRestart 已开启，正在重启 NapCat：${cfg.napcatLauncher}`);
      try {
        const child = spawn('cmd.exe', ['/c', cfg.napcatLauncher], { detached: true, stdio: 'ignore' });
        child.unref();
        state.consecutiveOffline = 0;
      } catch (e) {
        logLine(`[X] 重启失败：${e?.message ?? e}`);
      }
    } else {
      logLine('    处理方式：双击 C:\\napcat\\run-napcat.bat 扫码重新登录，或运行 repair-login.cmd。');
    }
  }

  if (status === 'down' && state.consecutiveOffline >= threshold) {
    logLine('[!] NapCat 持续不可用。双击 C:\\napcat\\headless-napcat.bat 启动它。');
  }

  state.lastState = status;
  state.checkedAt = Date.now();
  writeJson(STATE_PATH, state);
}

main().catch((e) => {
  logLine(`[X] 看门狗异常：${e?.message ?? e}`);
  process.exit(1);
});
