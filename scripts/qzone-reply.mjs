// 自动回复 QQ 空间动态：看白名单里的人在空间发了新说说，就用她的口吻去评论一句。
//
//   node scripts/qzone-reply.mjs --dry      只看会评论什么（不发送）
//   node scripts/qzone-reply.mjs --force    无视限额立刻跑一次
//   node scripts/qzone-reply.mjs            正常模式（调度循环每 10 分钟调一次）
//
// NapCat 只提供发说说（send_qzone_msg），**没有评论接口**，所以这里走 QQ 空间的
// Web 接口：用 OneBot get_cookies 拿到 cookie + skey，算出 g_tk 签名，
// 读说说用 emotion_cgi_msglist_v6，评论用 emotion_cgi_comment_v6。
// 这条链路属于非官方接口，被风控时只能降频或停用。
//
// 配置：config/qzone-reply.json（watch 里填要回复谁的 QQ 号）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'qzone-reply.json');
const STATE_PATH = path.join(REPO, 'config', 'qzone-reply.state.json');
const LIFE_PATH = path.join(REPO, 'config', 'qzone-life.json');

/** config/qzone-life.json 的兜底值（文件缺失也能跑） */
const LIFE_FALLBACK = {
  life: [],
  emoticons: { enabled: true, chance: 0.35, list: ['😅', '🙃', '🥲', '😴', '🤔', '😑'] },
};

function loadLife() {
  const raw = readJson(LIFE_PATH, {}) || {};
  return { ...LIFE_FALLBACK, ...raw };
}

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '');

function timeOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}

/** 每次调用随机抽一条写法指令，避免每条评论都同一个腔调 */
const STYLE_HINTS = [
  '这次写短一点，短到像随手两个字也行',
  '这次可以顺带说一句自己现在在干嘛',
  '这次只挑动态里的一个细节说，别整条都评价',
  '这次语气平淡一点，不必热情',
  '这次可以反问一句，但只问一个问题',
  '这次可以带点不服气，抬他一句',
  '这次不要用省略号开头，也不要用"又""还"开头',
  '这次可以自嘲一句',
];

/**
 * 把「她此刻是谁、在干嘛、最近说过什么」整理成提示词片段。
 * 这是让评论不像同一个模子刻出来的关键：状态在变、写法在变、还明确禁止重复自己。
 */
function humanContext(life, state) {
  const recent = Array.isArray(state.recentTexts) ? state.recentTexts.slice(-8) : [];
  const openers = [...new Set(recent.map((t) => String(t).slice(0, 3)).filter((x) => x.length >= 2))].slice(0, 4);
  const emo = life.emoticons || {};
  const useEmoji = emo.enabled !== false && Math.random() < Number(emo.chance ?? 0.35);
  return {
    lifeLine: pick(life.life || []),
    styleHint: pick(STYLE_HINTS),
    time: timeOfDay(),
    recent,
    openers,
    useEmoji,
    emoji: useEmoji ? pick(emo.list || ['😅', '🙃', '🥲']) : '',
  };
}

/** 拼进 system prompt 的拟人化片段 */
function humanPrompt(h) {
  const lines = [];
  if (h.lifeLine) lines.push(`你现在的生活状态：${h.lifeLine}（可以自然带出来，但别硬塞，也可以只当背景）`);
  lines.push(`现在是${h.time}，说话不必像刚睡醒那样敷衍，也不必刻意兴奋。`);
  lines.push(`这次的处理方式：${h.styleHint}。`);
  if (h.recent.length) lines.push(`你最近在空间里说过这些话：${h.recent.map((t) => `「${t}」`).join('')}。这次别再用同样的句式和说法。`);
  if (h.openers.length) lines.push(`也别再用这些开头：${h.openers.map((t) => `「${t}」`).join('')}。`);
  lines.push(h.useEmoji
    ? `可以在这句话后面带一个表情符号（最多一个，从这些里选：${(h.emoji || '🙃')}），不要带多个。`
    : '不要用任何 emoji 表情符号。');
  return lines.join('\n');
}


const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const FORCE = args.has('--force');
/** 只读诊断：打印她最近几条说说下的评论，不发任何东西 */
const PROBE = args.has('--probe');
/** 只读诊断：逐条说明"会回 / 为什么跳过" */
const EXPLAIN = args.has('--explain');

/** 取 --name value 形式的参数 */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function log(m) { console.log(`[qzone] ${m}`); }
function fail(m) { console.error(`[qzone] ${m}`); process.exit(1); }
function readJson(f, d = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, o) { fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`, 'utf8'); }

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
    } catch { /* 换下一个 */ }
  }
  return null;
}

function personaPrompt(id) {
  const file = path.join(REPO, 'config', 'personas', `${id}.yaml`);
  if (!fs.existsSync(file)) return '你是一个有自己想法的人。';
  try {
    const p = parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
    const s = p.structured ?? {};
    return [s.identity, s.speakingStyle, s.interactionStyle].filter(Boolean).join('\n');
  } catch { return '你是一个有自己想法的人。'; }
}

function bkn(skey) {
  let h = 5381;
  for (const ch of skey) h += (h << 5) + ch.charCodeAt(0);
  return (h & 0x7fffffff) >>> 0;
}
function cookieValue(cookies, name) {
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m?.[1] ?? '';
}

/**
 * 统一 QQ 号：接口有时返回数字，有时返回字符串，有时带 "o0" 前缀。
 * 以前直接用 `c.uin === Number(selfUin)` 判断"是不是她自己"，字符串一来就永远不等，
 * 于是她会回复自己的评论 —— 每轮都回，就成了"一直在自言自语"。
 */
function normUin(value) {
  const s = String(value ?? '').trim().replace(/^o0*/, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 连续失败先歇一阵。这条链路是非官方接口，被风控时每 10 分钟撞一次只会更糟，
 * 停 6 小时反而更容易恢复。
 */
const FAIL_STREAK_LIMIT = 3;
const FAIL_PAUSE_MS = 6 * 60 * 60 * 1000;

function noteFailure(state) {
  state.failStreak = Number(state.failStreak ?? 0) + 1;
  state.failCount = Number(state.failCount ?? 0) + 1;
  state.lastAttemptAt = Date.now();
  if (state.failStreak >= FAIL_STREAK_LIMIT) {
    state.pausedUntil = Date.now() + FAIL_PAUSE_MS;
    log(`连续失败 ${state.failStreak} 次，暂停到 ${new Date(state.pausedUntil).toLocaleString('zh-CN')}`);
  }
}

function noteSuccess(state) {
  state.failStreak = 0;
  state.pausedUntil = 0;
}
function stripTags(html) {
  return String(html ?? '')
    .replace(/\[em\]e\d+\[\/em\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 这条评论是否已经被她回过。
 *
 * 判据：她在这条评论之后、**下一条别人的评论之前**发过言。
 *
 * 不能只写「她在这条之后发过言」——她回了 B 之后，时间上晚于 A 的回复
 * 会让 A 也判成「已回过」，A 就永远等不到回复了。加了「下一条他人评论」
 * 这个上界，才分得清她的回复到底是给谁的。
 */
export function alreadyAnswered(comments, c, selfId) {
  let nextOtherAt = null;
  for (const o of comments) {
    if (o.uin === selfId || o.createdAt <= c.createdAt) continue;
    if (nextOtherAt == null || o.createdAt < nextOtherAt) nextOtherAt = o.createdAt;
  }
  return comments.some(
    (o) => o.uin === selfId && o.createdAt > c.createdAt && (nextOtherAt == null || o.createdAt < nextOtherAt),
  );
}


/** 连 OneBot，调一个 action，等 echo 回执 */
function callOneBot(url, action, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const echo = `qz-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

async function session(napcatUrl) {
  const data = await callOneBot(napcatUrl, 'get_cookies', { domain: 'qzone.qq.com' }, 15000);
  const cookies = typeof data === 'string' ? data : (data.cookies || data.data || '');
  // 空间的 g_tk 要用 p_skey 算；skey 算出来的会被判参数错误
  const skey = cookieValue(cookies, 'p_skey') || cookieValue(cookies, 'skey');
  const selfUin = (cookieValue(cookies, 'uin') || cookieValue(cookies, 'p_uin')).replace(/^o0*/, '');
  if (!cookies || !skey) throw new Error('拿不到有效的 qzone cookie/skey（会话可能已失效）');
  return { cookies, gtk: bkn(skey), selfUin };
}

/**
 * 剥 Qzone 的 JSON 壳：可能是纯 JSON、_Callback({...})、也可能是
 * <html><script>frameElement.callback({...})</script> 这种 HTML 包一层。
 * 解析不出来就抛错——以前解析失败被当成"没 code 就是成功"，导致假成功。
 */
function parseJsonp(text) {
  const s = String(text).trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`响应里没有 JSON：${s.slice(0, 120)}`);
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error(`响应不是合法 JSON：${s.slice(0, 120)}`);
  }
}

/** 读某人最近的说说。replynum = 每帖带回多少条评论（0 = 服务端默认） */
async function listPosts(s, uin, num = 5, replynum = 0) {
  const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
    + `?uin=${uin}&ftype=0&sort=0&pos=0&num=${num}&replynum=${replynum}&g_tk=${s.gtk}`
    + '&code_of_conduct=1&format=json&need_private_comment=1';
  const res = await fetch(url, {
    headers: { Cookie: s.cookies, Referer: `https://user.qzone.qq.com/${uin}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`读说说 HTTP ${res.status}`);
  const doc = parseJsonp(text);
  if (doc.code && doc.code !== 0) throw new Error(`读说说 code=${doc.code} ${doc.message ?? ''}`);
  return (doc.msglist ?? []).map((m) => ({
    tid: String(m.tid ?? ''),
    uin: normUin(m.uin ?? uin),
    content: stripTags(m.content),
    createdAt: Number(m.created_time ?? 0) * 1000,
    commentCount: Number(m.cmntnum ?? m.commentlist?.length ?? 0),
    comments: (m.commentlist ?? []).map((c) => ({
      uin: normUin(c.uin ?? 0),
      name: String(c.name ?? ''),
      content: stripTags(c.content),
      createdAt: Number(c.create_time ?? 0) * 1000,
    })).filter((c) => c.content),
  })).filter((m) => m.tid && m.content);
}

/** 评论一条说说。
 *
 * 端点是 h5.qzone.qq.com 的 emotion_cgi_re_feeds，topicId 必须是
 * `<宿主uin>_<tid>__1` 这种拼法；用 user.qzone.qq.com 的
 * emotion_cgi_comment_v6 会稳定返回 code:-3 参数错误。
 * 响应被 <html><script>frameElement.callback({...}) 包着，必须剥壳再判断 code/subcode。
 */
async function comment(s, targetUin, tid, content) {
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${s.selfUin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin: String(targetUin),
    format: 'json',
    ref: 'feeds',
    topicId: `${targetUin}_${tid}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: '',
    richval: '',
    isSignIn: '',
    uin: s.selfUin,
    content,
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${s.gtk}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: s.cookies,
      Referer: `https://user.qzone.qq.com/${targetUin}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  const doc = parseJsonp(text);
  const code = doc?.code ?? 0;
  const subcode = doc?.subcode ?? 0;
  if (!res.ok || code !== 0 || subcode !== 0) {
    throw new Error(`评论失败 HTTP ${res.status} code=${code} subcode=${subcode} ${(doc?.message || text).slice(0, 120)}`);
  }
  return doc;
}

async function generateComment(cfg, post, who, h) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);
  const min = cfg.style?.minChars ?? 3;
  const max = cfg.style?.maxChars ?? 30;
  const system = [
    personaPrompt(cfg.persona),
    '',
    `你在 QQ 空间看到${who || '对方'}发了一条动态，要评论一句。`,
    `要求：${min}~${max} 字，一句话，口语，别客套；`,
    '像随手打的，可以吐槽、可以接他的话、可以只评价其中某个细节；不要问一堆问题。',
    h ? humanPrompt(h) : '',
    '直接输出评论正文。',
  ].filter(Boolean).join('\n');
  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `动态内容：${post.content.slice(0, 500)}\n\n写一句评论。` },
      ],
      temperature: 0.9 + Math.random() * 0.2,
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  let text = String(doc?.choices?.[0]?.message?.content ?? '').trim();
  text = text.replace(/^[\s"'`「『（(\[]+/, '').replace(/[\s"'`」』）)\]]+$/, '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!text) throw new Error('模型返回空评论');
  return text.slice(0, max + 10);
}

/** 生成一条"回复别人评论"的话 */
async function generateCommentReply(cfg, post, c, h) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);
  const min = cfg.style?.minChars ?? 3;
  const max = cfg.style?.maxChars ?? 30;
  const system = [
    personaPrompt(cfg.persona),
    '',
    '你之前发了一条说说，现在有人在下面评论了。你要回他一句。',
    `要求：${min}~${max} 字，一句话，口语；可以顺着他说、反驳他、或者只吐槽其中一个点；`,
    '不用客套，别问一堆问题，直接输出回复正文。',
    h ? humanPrompt(h) : '',
  ].filter(Boolean).join('\n');
  const user = [
    `你的说说：${post.content.slice(0, 200)}`,
    `${c.name || '对方'}的评论：${c.content.slice(0, 200)}`,
    '',
    '写你的回复。',
  ].join('\n');
  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-flash',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.9 + Math.random() * 0.2,
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  let text = String(doc?.choices?.[0]?.message?.content ?? '').trim();
  text = text.replace(/^[\s"'`「『（(\[]+/, '').replace(/[\s"'`」』）)\]]+$/, '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!text) throw new Error('模型返回空回复');
  return text.slice(0, max + 10);
}

/**
 * 发送后回读校验。
 *
 * 空间接口有个坑：返回 code:0 不等于评论真的出现了（剥壳失败、风控吞掉都会这样）。
 * 用详情接口按 tid 拿全量评论，找不到自己刚发的那条就当没发成功，留给下一轮重试 ——
 * 不然会被永久记成"已回复"，对方永远等不到回应。
 */
async function verifyPosted(s, tid, text) {
  try {
    const comments = await listCommentsDetail(s, Number(s.selfUin), tid, 50);
    const head = String(text).replace(/\s+/g, '').slice(0, 6);
    return comments.some(
      (c) => c.uin === normUin(s.selfUin) && String(c.content).replace(/\s+/g, '').includes(head),
    );
  } catch (e) {
    // 校验本身失败不阻断：按已发送处理，避免重复刷屏
    log(`  回读校验出错（按已发送处理）：${e.message}`);
    return true;
  }
}

/**
 * 单条说说的评论详情（msgdetail 接口）。msglist 每帖只回传最近几条评论，
 * 她回得多了会把别人的评论挤出去；详情接口有时能拿到更全的列表。
 */
async function listCommentsDetail(s, uin, tid, num = 30) {
  const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6'
    + `?uin=${uin}&tid=${tid}&num=${num}&g_tk=${s.gtk}&format=json&need_private_comment=1`;
  const res = await fetch(url, {
    headers: { Cookie: s.cookies, Referer: `https://user.qzone.qq.com/${uin}` },
    signal: AbortSignal.timeout(20000),
  });
  const doc = parseJsonp(await res.text());
  if (!res.ok) throw new Error(`读评论详情 HTTP ${res.status}`);
  if (doc.code && doc.code !== 0) throw new Error(`读评论详情 code=${doc.code} ${doc.message ?? ''}`);
  return (doc.commentlist ?? []).map((c) => ({
    uin: normUin(c.uin ?? 0),
    name: String(c.name ?? ''),
    content: stripTags(c.content),
    createdAt: Number(c.create_time ?? 0) * 1000,
  })).filter((c) => c.content);
}

async function main() {
  const cfg = readJson(CFG_PATH);
  if (!cfg) fail(`读不到配置 ${CFG_PATH}`);
  const watch = (cfg.watch ?? []).filter((w) => Number.isFinite(Number(w?.uin)));
  // 评论别人和回复评论是两个独立开关：可以只开其中一个。
  // （以前 watch 为空直接 fail，导致"只回复评论"根本跑不起来。）
  const rcCfg = cfg.replyComments ?? {};
  const replyEnabled = rcCfg.enabled !== false;
  if (watch.length === 0 && !replyEnabled) {
    fail('watch（评论别人）和 replyComments（回复评论）都关着，没有可做的事');
  }
  if (watch.length === 0) log('未配置评论对象：跳过「评论别人的说说」，只做评论回复');
  if (!cfg.enabled && !FORCE) { log('已关闭（enabled=false）'); return; }

  const now = Date.now();
  const today = dayKey(new Date(now));
  const state = readJson(STATE_PATH, {}) ?? {};
  state.dayKey ??= today;
  state.seen ??= {};
  state.count ??= 0;
  state.recentTexts ??= [];
  if (state.dayKey !== today) { state.dayKey = today; state.count = 0; }
  // 连续失败后暂停中：直接退出，别再去撞接口（--force 可强制跑一次）
  if (!FORCE && !DRY && state.pausedUntil && now < state.pausedUntil) {
    log(`上次连续失败后暂停中，${new Date(state.pausedUntil).toLocaleString('zh-CN')} 之后再试（--force 可强制）`);
    return;
  }
  const life = loadLife();

  const limits = cfg.limits ?? {};
  const perDay = Number(limits.perDay ?? 2);
  const minGapMs = Number(limits.minGapMinutes ?? 30) * 60 * 1000;
  const maxAgeDays = Number(arg('max-age-days') ?? limits.maxAgeDays ?? 2);

  if (!FORCE && !DRY) {
    if (state.count >= perDay) { log(`今天已评论 ${state.count} 条，达到上限 ${perDay}`); return; }
    if (state.lastAt && now - state.lastAt < minGapMs) {
      log(`距上次评论不足 ${limits.minGapMinutes} 分钟，跳过`);
      return;
    }
  }

  const napcatUrl = cfg.napcat?.url ?? 'ws://127.0.0.1:3001';
  const s = await session(napcatUrl);
  log(`会话就绪：self=${s.selfUin} g_tk=${s.gtk}`);

  // --probe：只读诊断。看它到底能"看见"她最近几条说说下的哪些评论，
  // 用来回答「是不是每个人都回了」——能不能回，前提是能看见。
  if (PROBE) {
    const probeN = Number(cfg.replyComments?.scanPosts ?? 5);
    const base = await listPosts(s, Number(s.selfUin), probeN, 0);
    const wide = await listPosts(s, Number(s.selfUin), probeN, 20);
    log(`最近 ${base.length} 条说说；对比「replynum=0」和「replynum=20」能看到几条评论：`);
    for (let i = 0; i < base.length; i++) {
      const a = base[i];
      const b = wide[i] ?? { comments: [] };
      log(`  ${a.tid} · ${new Date(a.createdAt).toLocaleString('zh-CN')} · 服务端说共 ${a.commentCount} 条 · replynum=0 看到 ${a.comments.length} · replynum=20 看到 ${b.comments.length}`);
      for (const c of b.comments.length >= a.comments.length ? b.comments : a.comments) {
        const mine = c.uin === normUin(s.selfUin);
        log(`     - ${mine ? '[她自己]' : c.name || c.uin} @${new Date(c.createdAt).toLocaleString('zh-CN')}：${String(c.content).slice(0, 24)}`);
      }
      // msglist 每帖只回传最近几条；详情接口能不能拿全？
      try {
        const detail = await listCommentsDetail(s, Number(s.selfUin), a.tid, 30);
        log(`     [详情接口] 拿到 ${detail.length} 条（msglist 给的是 ${a.comments.length} 条）`);
      } catch (e) {
        log(`     [详情接口] 失败：${e.message}`);
      }
    }
    return;
  }

  let acted = 0;
  // 一轮最多回/评 1 条：minGapMinutes 只在开跑前检查一次，一轮里连发几条会让
  // 实际间隔变成几秒（实测出现过 23:22:58 与 23:23:02 两条），既不像人也不抗风控。
  const PER_RUN_MAX = 1;
  for (const w of watch) {
    if (acted >= PER_RUN_MAX) break;
    const uin = Number(w.uin);
    if (state.count >= perDay && !DRY) break;
    let posts = [];
    try { posts = await listPosts(s, uin, Number(limits.scanPosts ?? 5)); }
    catch (e) { log(`${w.name || uin}：读说说失败 ${e.message}`); continue; }

    const seen = state.seen[uin] ?? [];
    for (const post of posts.reverse()) {
      if (seen.includes(post.tid)) continue;
      if (post.uin !== uin) { seen.push(post.tid); continue; }   // 转发别人的，跳过
      if (now - post.createdAt > maxAgeDays * 86400000) { seen.push(post.tid); continue; }

      let text;
      try { text = await generateComment(cfg, post, w.name, humanContext(life, state)); }
      catch (e) { log(`生成评论失败：${e.message}`); continue; }
      log(`${w.name || uin} 新动态（${new Date(post.createdAt).toLocaleString('zh-CN')}）：${post.content.slice(0, 40)}`);
      log(`  → 评论：${text}`);

      if (DRY) { seen.push(post.tid); continue; }
      try {
        await comment(s, uin, post.tid, text);
        const landed = await verifyPosted(s, post.tid, text);
        if (!landed && !DRY) {
          log('  ⚠ 接口返回成功但帖子里没看到这条评论，下轮重试');
          continue;   // 不 push seen、不计数，留给下一轮
        }
        seen.push(post.tid);
        state.count += 1;
        state.lastAt = Date.now();
        state.lastText = text;
        state.recentTexts = [...state.recentTexts, text].slice(-8);
        acted += 1;
        noteSuccess(state);
        log('  ✓ 已评论（回读确认）');
      } catch (e) {
        log(`  ✗ ${e.message}`);
        noteFailure(state);
      }
      if (state.count >= perDay) break;
      if (acted >= PER_RUN_MAX) break;
    }
    state.seen[uin] = seen.slice(-100);
  }

  // ---- 回复她自己的说说下面的评论 ----
  // Qzone 的评论没有 id（只有 uin + create_time + content），所以去重用这三样拼
  const rc = cfg.replyComments ?? {};
  let replied = 0;
  if (rc.enabled !== false) {
    // 空名单 = 谁都回（别人评论了就回）；填了人才按名单过滤
    const watchComments = (Array.isArray(rc.watch) ? rc.watch : []).map(Number).filter((n) => n > 0);
    const replyAnyone = watchComments.length === 0;
    const rcPerDay = Number(rc.perDay ?? 3);
    const rcGapMs = Number(rc.minGapMinutes ?? 5) * 60 * 1000;
    const maxAgeH = Number(rc.maxAgeHours ?? 24);
    state.replySeen ??= {};
    state.replyCount ??= 0;
    state.replyDayKey ??= today;
    if (state.replyDayKey !== today) { state.replyDayKey = today; state.replyCount = 0; }

    const canReply = FORCE || DRY || (state.replyCount < rcPerDay && (!state.replyLastAt || now - state.replyLastAt >= rcGapMs));
    if (canReply) {
      let own = [];
      try { own = await listPosts(s, Number(s.selfUin), Number(rc.scanPosts ?? 5)); }
      catch (e) { log(`读自己的说说失败：${e.message}`); }

      const selfId = normUin(s.selfUin);
      for (const post of own) {
        if (state.replyCount >= rcPerDay && !DRY) break;
        // msglist 每帖带回最近几条评论，够用就不再多打一次详情接口：
        // 只有「一条别人的评论都没有」、且服务端说总数更多时，才怀疑是被她自己的回复挤掉了。
        let comments = post.comments;
        const hasOther = post.comments.some((c) => c.uin !== selfId);
        // --explain 是诊断，宁可多打一次请求也要看到全量
        if (EXPLAIN || (!hasOther && post.commentCount > post.comments.length)) {
          try {
            comments = await listCommentsDetail(s, Number(s.selfUin), post.tid, 50);
          } catch (e) {
            log(`  读评论详情失败，退回 msglist（${post.comments.length} 条）：${e.message}`);
          }
        }
        for (const c of comments) {
          const isSelf = c.uin === selfId;
          const key = `${post.tid}|${c.uin}|${c.createdAt}`;
          const already = (state.replySeen[key] ?? false) === true;
          const tooOld = now - c.createdAt > maxAgeH * 3600000;
          const inList = replyAnyone || watchComments.includes(c.uin);
          // 她在这条评论之后、下一条他人评论之前发过言 = 这条回过了。
          // 不靠 replySeen 单点判断：状态丢了、key 变了也不会重复回。
          const answered = alreadyAnswered(comments, c, selfId);
          // 兜底：内容和她说过的某句重复，就不再回（防止自己接自己的话）
          const echoesSelf = (state.recentTexts ?? []).some(
            (t) => String(t).replace(/\s+/g, '') === String(c.content).replace(/\s+/g, ''),
          );
          if (EXPLAIN) {
            const what = isSelf ? '跳过（她自己的）'
              : answered ? '跳过（已回过）'
                : already ? '跳过（已回过）'
                  : !inList ? '跳过（不在名单）'
                    : tooOld ? '跳过（超出时间窗）'
                      : echoesSelf ? '跳过（和她刚说的一样）'
                        : '会回复';
            log(`  ${what} ← ${isSelf ? '[她自己]' : c.name || c.uin} @${new Date(c.createdAt).toLocaleString('zh-CN')}：${String(c.content).slice(0, 18)}`);
            continue;
          }
          if (isSelf) continue;                                     // 自己的评论不回
          if (answered) { state.replySeen[key] = true; continue; }  // 已经回过
          if (!inList) continue;                                    // 填了名单才过滤
          if (already) continue;
          if (echoesSelf) { state.replySeen[key] = true; continue; }
          if (tooOld) { state.replySeen[key] = true; continue; }

          let text;
          try { text = await generateCommentReply(cfg, post, c, humanContext(life, state)); }
          catch (e) { log(`生成回复失败：${e.message}`); continue; }
          log(`${c.name || c.uin} 评论了她的说说：${c.content.slice(0, 30)}`);
          log(`  → 回复：${text}`);

          if (DRY) { state.replySeen[key] = true; continue; }
          try {
            await comment(s, Number(s.selfUin), post.tid, text);
            const landed = await verifyPosted(s, post.tid, text);
            if (!landed) {
              log('  ⚠ 接口返回成功但空间里没看到这条回复，留到下一轮重试');
              continue;   // 不记 replySeen、不计数
            }
            state.replySeen[key] = true;
            state.replyCount += 1;
            state.replyLastAt = Date.now();
            state.replyLastText = text;
            state.recentTexts = [...state.recentTexts, text].slice(-8);
            replied += 1;
            noteSuccess(state);
            log('  ✓ 已回复（回读确认）');
          } catch (e) {
            log(`  ✗ ${e.message}`);
            noteFailure(state);
          }
          if (state.replyCount >= rcPerDay) break;
          if (replied >= PER_RUN_MAX) break;   // 一轮只回一条，保证真实的分钟级间隔
        }
        if (replied >= PER_RUN_MAX) break;
      }
      // 只保留最近 200 条，避免状态文件无限膨胀
      const keys = Object.keys(state.replySeen);
      if (keys.length > 200) {
        const drop = keys.slice(0, keys.length - 200);
        for (const k of drop) delete state.replySeen[k];
      }
    } else {
      log('回复评论：今天额度用完或间隔未到，跳过');
    }
  }

  // dry 不落盘：否则试跑一次就把这些 tid 记成"已回复"，之后真跑什么都不做
  if (!DRY) writeJson(STATE_PATH, state);
  log(`完成，本次评论 ${acted} 条、回复 ${replied} 条；今天评论 ${state.count}/${perDay}、回复 ${state.replyCount ?? 0}`);
}

// 只有直接运行时才跑 main()：被测试 import 时不应该真的去连 OneBot。
const isEntry = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main().catch((e) => { console.error(`[qzone] 失败：${e?.message ?? e}`); process.exit(1); });
