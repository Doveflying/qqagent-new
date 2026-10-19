// 主动私聊：偶尔由她先开口，给主人发一条消息。
//
// 每天只在活跃窗口里随机挑一个时间点，一天最多一条；
// 你刚聊过天（默认 45 分钟内）就不打扰，直接顺延；
// 内容按人格口吻生成，会参考最近的聊天上下文，但不重复你已经说过的话题。
//
//   node scripts/proactive-dm.mjs            正常判断（调度循环每 10 分钟调一次）
//   node scripts/proactive-dm.mjs --dry      只生成不发送
//   node scripts/proactive-dm.mjs --force    无视时间/限额，立刻发一条
//
// 配置：config/proactive.json（可被 config/proactive.local.json 覆盖目标 QQ）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'proactive.json');
const STATE_PATH = path.join(REPO, 'config', 'proactive.state.json');
const DB_PATH = path.join(REPO, 'data', 'brain.db');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY = args.has('--dry');

function log(msg) { console.log(`[proactive] ${msg}`); }
function fail(msg) { console.error(`[proactive] ${msg}`); process.exit(1); }

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** 从 providers.local.yaml / providers.yaml 读供应商凭据。 */
function providerCreds(key) {
  for (const file of ['providers.local.yaml', 'providers.yaml']) {
    const full = path.join(REPO, 'config', file);
    if (!fs.existsSync(full)) continue;
    try {
      const doc = parseYaml(fs.readFileSync(full, 'utf8')) ?? {};
      const p = doc.providers?.[key];
      if (!p) continue;
      let apiKey = p.apiKey ?? '';
      if (!apiKey && p.apiKeyEnv) apiKey = process.env[p.apiKeyEnv] ?? '';
      return { baseURL: String(p.baseURL ?? '').replace(/\/+$/, ''), apiKey };
    } catch { /* 换下一个文件 */ }
  }
  return null;
}

/** 读人格文件，拼一个"她的口吻"的系统提示。 */
function personaPrompt(personaId) {
  const file = path.join(REPO, 'config', 'personas', `${personaId}.yaml`);
  if (!fs.existsSync(file)) return '你是一个有自己想法的人。';
  try {
    const p = parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
    const s = p.structured ?? {};
    const parts = [s.identity, s.speakingStyle, s.interactionStyle].filter(Boolean);
    return parts.length ? parts.join('\n') : String(p.systemPrompt ?? '').slice(0, 1800);
  } catch {
    return '你是一个有自己想法的人。';
  }
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new Error(`时间格式应为 HH:mm：${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
function hhmmOf(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 在活跃窗口内随机挑一个时间点（毫秒时间戳）。 */
function pickTargetToday(now, limits) {
  const from = minutesOf(limits.activeFrom ?? '10:30');
  const to = minutesOf(limits.activeTo ?? '23:00');
  const span = Math.max(1, to - from);
  const pick = from + Math.floor(Math.random() * span);
  const d = new Date(now);
  d.setHours(Math.floor(pick / 60), pick % 60, Math.floor(Math.random() * 60), 0);
  return d.getTime();
}

/** 从 brain.db 读她与该用户的私聊记录，给模型当上下文。 */
async function recentChat(uid, limit = 8) {
  if (!fs.existsSync(DB_PATH)) return [];
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const scope = `private:${uid}`;
    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE scope=? ORDER BY id DESC LIMIT ?',
    ).all(scope, limit);
    db.close();
    return rows.reverse().map((r) => ({
      role: r.role === 'user' ? 'user' : 'assistant',
      content: String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }));
  } catch {
    try { db?.close(); } catch { /* ignore */ }
    return [];
  }
}

/** 最近一条「用户本人」消息的时间戳，用来判断是不是正在聊。 */
async function lastUserMessageAt(uid) {
  if (!fs.existsSync(DB_PATH)) return 0;
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare(
      "SELECT MAX(created_at) AS t FROM messages WHERE scope=? AND role='user'",
    ).get(`private:${uid}`);
    db.close();
    return Number(row?.t ?? 0) || 0;
  } catch {
    try { db?.close(); } catch { /* ignore */ }
    return 0;
  }
}

async function generateMessage(cfg, uid) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);

  const min = cfg.style?.minChars ?? 4;
  const max = cfg.style?.maxChars ?? 40;
  const now = new Date();
  const stamp = `${now.getMonth() + 1}月${now.getDate()}日 ${hhmmOf(now.getTime())}`;

  const history = await recentChat(uid);
  const context = history.length
    ? history.map((m) => `${m.role === 'user' ? '他' : '我'}：${m.content}`).join('\n')
    : '（最近没聊过什么）';

  const system = [
    personaPrompt(cfg.persona),
    '',
    '现在是你自己想起要找他说话，不是他问你。',
    `要求：${min}~${max} 字，一两句就够，口语，像随手发的一条消息；`,
    '不要寒暄套话（"在吗""在干嘛""忙吗"），不要解释你为什么发消息，不要问他问题当作开场；',
    '可以说你刚在做的事、突然想到的事、或者对之前聊过的一句追加；',
    '不用 emoji，不用书名号引号包裹，直接给消息正文。',
  ].join('\n');

  const user = [
    `现在是 ${stamp}。`,
    '',
    '你们最近的对话：',
    context,
    '',
    '写一条你现在想主动发给他的话。',
  ].join('\n');

  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.95,
      // deepseek-flash 带推理，输出预算给小了 content 会是空的
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  let text = String(doc?.choices?.[0]?.message?.content ?? '').trim();
  // 模型偶尔会把整条消息包在引号里，或者残留"我："前缀
  text = text
    .replace(/^(我|她|宫城志绪理)[:：]\s*/, '')
    .replace(/^[\s"'`「『（(\[]+/, '')
    .replace(/[\s"'`」』）)\]]+$/, '')
    .trim();
  if (!text) throw new Error('模型返回空内容');
  return text;
}

/** 连 OneBot，调用一个 action，等 echo 回执。 */
function callOneBot(url, action, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const echo = `proactive-${Date.now()}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`${action} 超时`)); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ action, params, echo }));
    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.echo !== echo) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (d.retcode === 0) resolve(d.data);
      else reject(new Error(`${action} 失败 retcode=${d.retcode} ${d.message ?? d.wording ?? ''}`));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`连不上 OneBot：${url}`)); };
  });
}

async function main() {
  const cfg = readJson(CFG_PATH);
  if (!cfg) fail(`读不到配置 ${CFG_PATH}`);

  // 本地覆盖：config/proactive.local.json（.gitignore 排除）放目标 QQ
  const localCfg = readJson(path.join(REPO, 'config', 'proactive.local.json'));
  if (localCfg && typeof localCfg === 'object') {
    cfg.target = Object.assign({}, cfg.target, localCfg.target || {});
    if (localCfg.limits) cfg.limits = Object.assign({}, cfg.limits, localCfg.limits);
    if (localCfg.style) cfg.style = Object.assign({}, cfg.style, localCfg.style);
  }

  const users = (cfg.target?.users ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (users.length === 0) fail('没有目标 QQ：在 config/proactive.local.json 里配 target.users');
  const uid = users[0];

  if (!cfg.enabled && !FORCE) { log('已关闭（proactive.json 里 enabled=false）'); return; }

  const now = Date.now();
  const today = dayKey(new Date(now));
  const state = readJson(STATE_PATH, {}) ?? {};
  const limits = cfg.limits ?? {};

  // 每天重置：重新挑一个随机时间点
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.count = 0;
    state.targetAt = pickTargetToday(now, limits);
    writeJson(STATE_PATH, state);
    log(`新的一天，今日目标时间 ${hhmmOf(state.targetAt)}`);
  }

  const perDay = Number(limits.perDay ?? 1);
  const minGapMs = Number(limits.minGapHours ?? 10) * 3600 * 1000;
  const quietMs = Number(limits.skipIfUserActiveMinutes ?? 45) * 60 * 1000;

  if (!FORCE && !DRY) {
    if (Number(state.count ?? 0) >= perDay) { log(`今天已发 ${state.count} 条，达到上限 ${perDay}`); return; }
    if (Number(state.failCount ?? 0) >= 3) { log('今天失败已 3 次，不再重试'); return; }
    if (state.lastAttemptAt && now - state.lastAttemptAt < 30 * 60 * 1000) {
      log(`上次失败，${Math.ceil((30 * 60 * 1000 - (now - state.lastAttemptAt)) / 60000)} 分钟后才会再试`);
      return;
    }
    if (state.lastAt && now - state.lastAt < minGapMs) {
      log(`距上次主动私聊不足 ${limits.minGapHours} 小时，还剩约 ${Math.ceil((minGapMs - (now - state.lastAt)) / 3600000)} 小时`);
      return;
    }

    // 你正在聊天就别插嘴：把目标时间往后挪，今天还有机会
    const lastUser = await lastUserMessageAt(uid);
    if (lastUser && now - lastUser < quietMs) {
      const left = Math.ceil((quietMs - (now - lastUser)) / 60000);
      const to = minutesOf(limits.activeTo ?? '23:00');
      const next = Number(state.targetAt ?? 0) + 30 * 60 * 1000;
      if (new Date(next).getHours() * 60 + new Date(next).getMinutes() < to) state.targetAt = next;
      writeJson(STATE_PATH, state);
      log(`他 ${left} 分钟前还在说话，不打扰；下次目标时间 ${hhmmOf(state.targetAt)}`);
      return;
    }

    if (now < Number(state.targetAt ?? 0)) {
      log(`还没到今天的随机时间点（${hhmmOf(state.targetAt)}）`);
      return;
    }

    // 窗口外不发（--force 例外）
    const mins = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    if (mins < minutesOf(limits.activeFrom ?? '10:30') || mins > minutesOf(limits.activeTo ?? '23:00')) {
      log('不在活跃时间窗口内');
      return;
    }
  }

  log('生成主动消息…');
  const text = await generateMessage(cfg, uid);
  log(`内容（${text.length} 字）：${text}`);
  if (DRY) { log('--dry，不发送'); return; }

  const url = cfg.napcat?.url ?? 'ws://127.0.0.1:3001';
  try {
    await callOneBot(url, 'send_private_msg', {
      user_id: uid,
      message: [{ type: 'text', data: { text } }],
    }, 30000);
  } catch (e) {
    state.lastAttemptAt = now;
    state.failCount = Number(state.failCount ?? 0) + 1;
    writeJson(STATE_PATH, state);
    throw new Error(`私聊 ${uid} 失败：${e?.message ?? e}`);
  }

  state.count = Number(state.count ?? 0) + 1;
  state.lastAt = now;
  state.failCount = 0;
  state.lastText = text.slice(0, 200);
  writeJson(STATE_PATH, state);
  log(`已发给 ${uid}，今天第 ${state.count} 条`);
}

main().catch((e) => { console.error(`[proactive] 失败：${e?.message ?? e}`); process.exit(1); });
