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

/**
 * 询问 NapCat：返回 { online, login, bkn } 或 { error }。
 *
 * 关键：get_status.online 会说谎。内核会话失效时它仍返回 true，
 * 但此时 QQ 空间、发送消息都会报 1006514「网络连接异常」。
 * 真正可靠的是 get_cookies 拿到的 bkn —— 会话活着才有值，失效时为空串。
 * 这个探测没有任何副作用，不会发消息、不会打接口。
 */
function probe(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return done({ error: String(e?.message ?? e) }); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ error: 'timeout' }); }, timeoutMs);

    const out = { bkn: null };
    let got = 0;
    const total = 3;
    const collect = () => {
      if (++got < total) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      done(out);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'login' }));
      ws.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'status' }));
      ws.send(JSON.stringify({ action: 'get_cookies', params: { domain: 'qzone.qq.com' }, echo: 'cookies' }));
    };
    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      // 必须先按 echo 过滤：NapCat 会先推 meta_event(lifecycle)，那不是回复。
      if (d.echo === 'login') { out.login = d.data ?? d.message; collect(); }
      else if (d.echo === 'status') { out.status = d.data ?? d.message; collect(); }
      else if (d.echo === 'cookies') {
        const bkn = d.data?.bkn;
        out.bkn = typeof bkn === 'string' ? bkn : '';
        collect();
      }
    };
    ws.onerror = () => { clearTimeout(timer); done({ error: 'connect-failed' }); };
  });
}

async function agentState(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { reachable: true, onebot: false };
    const doc = await r.json();
    return { reachable: true, onebot: doc?.runtime?.onebot?.connected === true };
  } catch {
    return { reachable: false, onebot: false };
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
  const agent = await agentState(cfg.agentUrl);
  const agentLabel = agent.reachable ? (agent.onebot ? 'ok' : 'onebot-down') : 'DOWN';

  let status;      // 'online' | 'offline' | 'down'
  let detail = '';
  const uid = result.login?.user_id ?? '?';
  const bkn = result.bkn;

  if (result.error) {
    status = 'down';
    detail = `NapCat 无法连接（${result.error}）`;
  } else if (result.status?.online === true && typeof bkn === 'string' && bkn !== '') {
    status = 'online';
    detail = `账号 ${uid} 在线（bkn 正常）`;
  } else if (result.status?.online === true) {
    // 经典假在线：online=true，但会话密钥（bkn）为空。
    // 此时能查账号信息，但发消息会报 1006514「网络连接异常」。
    status = 'offline';
    detail = `账号 ${uid} 假在线：online=true 但 bkn 为空，消息发不出去，需要重新登录`;
  } else {
    status = 'offline';
    detail = `账号 ${uid} 已断线（online=false），进程和端口仍正常`;
  }

  // 连续计数：只有 offline 才累加，其余清零
  state.consecutiveOffline = status === 'offline' ? Number(state.consecutiveOffline ?? 0) + 1 : 0;

  const changed = state.lastState !== status;
  if (changed || VERBOSE) {
    logLine(`${status.toUpperCase()} ${detail} | agent=${agentLabel} | 连续断线=${state.consecutiveOffline}`);
  }

  if (!agent.reachable) {
    logLine('提示：Agent 进程不在（/api/health 无响应），双击桌面的 QQ Agent 启动');
  } else if (!agent.onebot) {
    logLine('提示：Agent 在运行但没连上 OneBot，等 NapCat 恢复后它会自动重连');
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
