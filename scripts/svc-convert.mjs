// 歌声/语音转换：Seed-VC v2 零样本音色转换
//
//   node scripts/svc-convert.mjs --source refs/source.wav
//   node scripts/svc-convert.mjs --source refs/song.wav --send 2731758714
//
// --source  要被转换的人声（歌曲人声轨、或任意说话音频）
// --target  参考音色，默认 refs/voice.wav（10-30 秒她的声音）
// --send    转完通过 OneBot 发语音：填 QQ 号（私聊）或 group:群号
//
// 首次运行会下载约 1.6 GB 模型到 .svc-tmp/hf（国内走 hf-mirror）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SEEDVC = path.join(REPO, 'tools', 'seed-vc-main');
const VENV_PY = path.join(REPO, '.svc-env', 'Scripts', 'python.exe');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function log(m) { console.log(`[svc] ${m}`); }
function fail(m) { console.error(`[svc] ${m}`); process.exit(1); }

// 子进程 cwd 是 Seed-VC 目录，所有路径必须先转绝对路径
const sourceArg = arg('source');
const source = sourceArg ? path.resolve(sourceArg) : null;
const targetArg = arg('target', path.join(REPO, 'refs', 'voice.wav'));
const target = path.resolve(targetArg);
const sendTo = arg('send');
const steps = arg('steps', '30');

if (!source) fail('用法：--source refs/bai.wav [--target refs/voice.wav] [--send 2731758714|group:123]');
if (!fs.existsSync(source)) fail(`源音频不存在：${source}`);
if (!fs.existsSync(target)) fail(`参考音频不存在：${target}`);
if (!fs.existsSync(VENV_PY)) fail(`找不到 venv 里的 python：${VENV_PY}（先跑 svc-setup.cmd）`);
if (!fs.existsSync(SEEDVC)) fail(`找不到 Seed-VC：${SEEDVC}`);

const outDir = path.join(REPO, 'outputs', `svc-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

log(`源：${path.relative(REPO, source)}`);
log(`参考：${path.relative(REPO, target)}`);
log('开始转换（首次会下载模型，可能几分钟）…');

const env = {
  ...process.env,
  HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
  HF_HOME: process.env.HF_HOME || path.join(REPO, '.svc-tmp', 'hf'),
  PYTHONIOENCODING: 'utf-8',
};

const t0 = Date.now();
const r = spawnSync(VENV_PY, [
  'inference_v2.py',
  '--source', source,
  '--target', target,
  '--output', outDir,
  '--diffusion-steps', steps,
  '--convert-style', 'True',
], { cwd: SEEDVC, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (r.error) fail(`调用失败：${r.error.message}`);
const tail = (r.stdout || '').trim().split('\n').slice(-4).join('\n');
if (tail) log(tail);
if (r.status !== 0) fail(`推理失败（退出码 ${r.status}）：${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);

const produced = fs.readdirSync(outDir).filter((f) => f.endsWith('.wav'));
if (produced.length === 0) fail(`没有生成音频，输出目录：${outDir}`);
const output = path.join(outDir, produced[0]);
const sec = ((Date.now() - t0) / 1000).toFixed(0);
log(`完成：${path.relative(REPO, output)}（${sec}s，${(fs.statSync(output).size / 1024).toFixed(0)} KB）`);

// ---------- 发送到 QQ ----------
function callOneBot(action, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const echo = `svc-${Date.now()}`;
    const ws = new WebSocket('ws://127.0.0.1:3001');
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`${action} 超时`)); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ action, params, echo }));
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.echo !== echo) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (d.retcode === 0) resolve(d.data);
      else reject(new Error(`${action} retcode=${d.retcode} ${String(d.message ?? '').replace(/\s+/g, ' ').slice(0, 160)}`));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连不上 OneBot 3001')); };
  });
}

async function send() {
  if (!sendTo) { log('未指定 --send，跳过发送'); return; }
  const b64 = fs.readFileSync(output).toString('base64');
  const seg = { type: 'record', data: { file: `base64://${b64}` } };

  if (sendTo.startsWith('group:')) {
    const gid = Number(sendTo.slice(6));
    await callOneBot('send_group_msg', { group_id: gid, message: [seg] }, 120000);
    log(`已发送到群 ${gid}`);
  } else {
    const uid = Number(sendTo);
    if (!Number.isSafeInteger(uid) || uid <= 0) fail(`--send 参数不合法：${sendTo}`);
    await callOneBot('send_private_msg', { user_id: uid, message: [seg] }, 120000);
    log(`已私聊发送给 ${uid}`);
  }
}

send().catch((e) => fail(`发送失败：${e.message}`));
