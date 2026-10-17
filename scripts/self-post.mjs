// 自发动态：按人格自己写一条 QQ 空间说说，并受频率限制。
//
// 设计目标是"少而精"：
//   - 每天最多 perDay 条（默认 1）
//   - 每次在 activeFrom~activeTo 之间随机挑一个时间点，不是固定钟点，避免机械感
//   - 两次之间至少间隔 minGapHours 小时
//   - 不依赖 QQagent 进程，直接连 NapCat 的 OneBot WS 发 send_qzone_msg
//
// 用法：
//   node scripts/self-post.mjs            检查是否该发（定时器调用这个）
//   node scripts/self-post.mjs --force    忽略时间限制，立刻发一条（测试用）
//   node scripts/self-post.mjs --dry      只生成内容并打印，不发送
//
// 状态文件：config/self-post.state.json（记录今天的目标时间与上次发布时间）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'self-post.json');
const STATE_PATH = path.join(REPO, 'config', 'self-post.state.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY = args.has('--dry');

function log(msg) { console.log(`[self-post] ${msg}`); }
function fail(msg) { console.error(`[self-post] ${msg}`); process.exit(1); }

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
    const parts = [s.identity, s.speakingStyle, s.answerPrinciples].filter(Boolean);
    return parts.length ? parts.join('\n') : String(p.systemPrompt ?? '').slice(0, 1500);
  } catch {
    return '你是一个有自己想法的人。';
  }
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new Error(`时间格式应为 HH:mm：${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 今天的日期键，用于每日重置。 */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 在活跃窗口内随机挑一个时间点（毫秒时间戳）。 */
function pickTargetToday(now, limits) {
  const from = minutesOf(limits.activeFrom ?? '09:00');
  const to = minutesOf(limits.activeTo ?? '23:00');
  const span = Math.max(1, to - from);
  const pick = from + Math.floor(Math.random() * span);
  const d = new Date(now);
  d.setHours(Math.floor(pick / 60), pick % 60, Math.floor(Math.random() * 60), 0);
  return d.getTime();
}

async function generatePost(cfg) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);

  const topics = cfg.style?.topics ?? [];
  const seed = topics.length ? topics[Math.floor(Math.random() * topics.length)] : '今天的心情';
  const min = cfg.style?.minChars ?? 25;
  const max = cfg.style?.maxChars ?? 90;

  const now = new Date();
  const stamp = `${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const system = [
    personaPrompt(cfg.persona),
    '',
    '现在你要在 QQ 空间发一条只属于自己的说说——不是回复任何人，是你自己的想法。',
    `要求：${min}~${max} 字，口语，像随手打出来的；不写标题、不写话题标签、不用 emoji 表情符号；`,
    '不解释你在做什么，不写"今天也是元気的一天"这种模板句；可以有情绪、有判断、有具体的小细节。',
    '只说一件事，别铺陈。',
  ].join('\n');

  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `现在是 ${stamp}。可以想想：${seed}。直接写出说说正文。` },
      ],
      temperature: 1.0,
      // deepseek-flash 是带推理的模型：思考过程会占用输出预算，
      // 上限给小了会导致 content 为空（reasoning 把 token 吃光）。
      max_tokens: 1600,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  let text = String(doc?.choices?.[0]?.message?.content ?? '').trim();
  // 模型偶尔会带引号或残留的半截括号，统一清掉首尾的包裹字符
  text = text.replace(/^[\s"'`「『（(\[]+/, '').replace(/[\s"'`」』）)\]]+$/, '').trim();
  if (!text) throw new Error('模型返回空内容');
  return text;
}

/** 连 OneBot，调用一个 action，等 echo 回执。 */
function callOneBot(url, action, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const echo = `self-post-${Date.now()}`;
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
  if (!cfg.enabled && !FORCE) { log('已关闭（self-post.json 里 enabled=false）'); return; }

  const now = Date.now();
  const today = dayKey(new Date(now));
  const state = readJson(STATE_PATH, {}) ?? {};

  // 每天重置：重新挑一个随机时间点
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.count = 0;
    state.targetAt = pickTargetToday(now, cfg.limits ?? {});
    writeJson(STATE_PATH, state);
    log(`新的一天，今日目标时间 ${new Date(state.targetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
  }

  const limits = cfg.limits ?? {};
  const perDay = Number(limits.perDay ?? 1);
  const minGapMs = Number(limits.minGapHours ?? 18) * 3600 * 1000;

  if (!FORCE) {
    if (Number(state.count ?? 0) >= perDay) { log(`今天已发 ${state.count} 条，达到上限 ${perDay}`); return; }
    if (Number(state.failCount ?? 0) >= 3) { log('今天失败已 3 次，不再重试'); return; }
    // 失败后别每 10 分钟重来一遍：至少等 30 分钟，且每次都会重新生成内容，
    // 反复重试只会白烧 token。
    if (state.lastAttemptAt && now - state.lastAttemptAt < 30 * 60 * 1000) {
      const left = Math.ceil((30 * 60 * 1000 - (now - state.lastAttemptAt)) / 60000);
      log(`上次尝试失败，${left} 分钟后才会再试`);
      return;
    }
    if (state.lastAt && now - state.lastAt < minGapMs) {
      const left = Math.ceil((minGapMs - (now - state.lastAt)) / 3600000);
      log(`距上次发布不足 ${limits.minGapHours} 小时，还剩约 ${left} 小时`);
      return;
    }
    if (now < Number(state.targetAt ?? 0)) {
      log(`还没到今天的随机时间点（${new Date(state.targetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`);
      return;
    }
  }

  log('开始生成说说…');
  const text = await generatePost(cfg);
  log(`内容（${text.length} 字）：${text}`);
  if (DRY) { log('--dry，不发送'); return; }

  const url = cfg.napcat?.url ?? 'ws://127.0.0.1:3001';
  let delivered = 0;
  let lastError = null;
  let qzoneFailed = false;

  if (cfg.target?.qzone !== false) {
    try {
      const r = await callOneBot(url, 'send_qzone_msg', {
        content: text,
        ugc_right: Number(cfg.target?.ugcRight ?? 1),
      }, 60000);
      log(`已发 QQ 空间，tid=${r?.tid ?? '?'}`);
      delivered++;
    } catch (e) {
      lastError = e;
      qzoneFailed = true;
      log(`QQ 空间发送失败：${e?.message ?? e}`);
    }
  }

  // 空间关闭（qzone=false）或发送失败时，改走私聊。
  // 注意：这段必须独立于上面的 try，否则关掉空间后私聊也不会执行。
  const users = cfg.target?.users ?? [];
  if ((cfg.target?.qzone === false || qzoneFailed) && cfg.target?.fallbackToUsers !== false && users.length > 0) {
    log(`通过私聊发送（${users.length} 个目标）…`);
    for (const u of users) {
      const uid = Number(u);
      if (!Number.isSafeInteger(uid) || uid <= 0) continue;
      try {
        await callOneBot(url, 'send_private_msg', {
          user_id: uid,
          message: [{ type: 'text', data: { text } }],
        }, 30000);
        log(`已私聊发送给 ${uid}`);
        delivered++;
      } catch (e2) {
        lastError = e2;
        log(`私聊 ${uid} 失败：${e2?.message ?? e2}`);
      }
    }
  }

  for (const group of cfg.target?.groups ?? []) {
    const gid = Number(group);
    if (!Number.isSafeInteger(gid) || gid <= 0) continue;
    try {
      await callOneBot(url, 'send_group_msg', {
        group_id: gid,
        message: [{ type: 'text', data: { text } }],
      }, 30000);
      log(`已发群 ${gid}`);
      delivered++;
    } catch (e) {
      lastError = e;
      log(`群 ${gid} 发送失败：${e?.message ?? e}`);
    }
  }

  if (delivered === 0) {
    // 记下失败，避免每 10 分钟重新生成一遍内容
    state.lastAttemptAt = now;
    state.failCount = Number(state.failCount ?? 0) + 1;
    writeJson(STATE_PATH, state);
    throw lastError ?? new Error('没有任何目标发送成功');
  }

  state.count = Number(state.count ?? 0) + 1;
  state.lastAt = now;
  state.failCount = 0;
  writeJson(STATE_PATH, state);
  log(`完成，今天第 ${state.count} 条`);
}

main().catch((e) => { console.error(`[self-post] 失败：${e?.message ?? e}`); process.exit(1); });
