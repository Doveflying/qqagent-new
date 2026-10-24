// 自发动态：按人格自己写一条 QQ 空间说说，并受频率限制。
//
// 设计目标是"少而精"：
//   - 每天最多 perDay 条（默认 1）
//   - 时间可以是「指定钟点 + 随机浮动」（limits.times + jitterMinutes），
//     也可以留空，在 activeFrom~activeTo 之间随机挑，避免机械感
//   - 两次之间至少间隔 minGapHours 小时
//   - 不依赖 QQagent 进程，直接连 NapCat 的 OneBot WS 发 send_qzone_msg
//
// 用法：
//   node scripts/self-post.mjs            检查是否该发（定时器调用这个）
//   node scripts/self-post.mjs --force    忽略时间限制，立刻发一条（测试用）
//   node scripts/self-post.mjs --dry      只生成内容并打印，不发送
//
// 状态文件：config/self-post.state.json（记录今天的目标时间、上次发布时间与最近发过的内容）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'self-post.json');
const STATE_PATH = path.join(REPO, 'config', 'self-post.state.json');
const LIFE_PATH = path.join(REPO, 'config', 'qzone-life.json');

/** 和 qzone-reply.mjs 共用同一份「日常」配置 */
function loadLife() {
  const raw = readJson(LIFE_PATH, {}) || {};
  return {
    life: Array.isArray(raw.life) ? raw.life : [],
    emoticons: raw.emoticons || { enabled: true, chance: 0.3, list: ['😅', '🙃', '🥲', '😴'] },
    images: raw.images || { enabled: false, dir: 'refs/qzone', chance: 0.5 },
  };
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

function weekdayOf(d = new Date()) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

function seasonOf(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m <= 2 || m === 12) return '冬天';
  if (m <= 5) return '春天';
  if (m <= 8) return '夏天';
  return '秋天';
}

/**
 * 每次随机抽一条写法指令。
 * 这是"不像同一个模子刻出来的"的关键：状态在变、写法在变、还明确禁止重复自己。
 */
const STYLE_HINTS = [
  '只写半句也行，剩下的让人自己补',
  '写一件今天发生的小事，别评价它',
  '可以只是抱怨一句，不用给结论',
  '写一个突然冒出来的念头，不用有前因后果',
  '语气平淡一点，别抒情',
  '可以自嘲一句',
  '写个具体的东西：一个味道、一个声音、一个温度',
  '短到只有六七个字也可以',
  '可以对着某个不存在的人说一句话',
  '写一句你没说出口的话',
];

/** 模型最容易套的模板开头，明确禁掉 */
const BANNED_OPENERS = ['今天也是', '记录一下', '最近', '好久没', '突然想到', '有时候', '其实我', '生活总是'];
const BANNED_WORDS = ['仿佛', '似乎', '不禁', '或许', '大抵', '莫名', '莫名地', '不禁感叹'];

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
  const pickMinute = from + Math.floor(Math.random() * span);
  const d = new Date(now);
  d.setHours(Math.floor(pickMinute / 60), pickMinute % 60, Math.floor(Math.random() * 60), 0);
  return d.getTime();
}

/**
 * 今天的发布时间点（按 perDay 生成，已排序）。
 *
 * 两种模式：
 *  - `limits.times` 非空：用你指定的钟点，每个再随机浮动 ±jitterMinutes，
 *    这样不会每天同一分同一秒发出去（机械感是"像人"最大的破绽）
 *  - 留空：在 activeFrom~activeTo 之间随机挑，行为与旧版一致
 */
export function pickTargets(now, limits = {}, rand = Math.random) {
  const perDay = Math.max(1, Math.min(5, Number(limits.perDay ?? 1) || 1));
  const jitter = Math.max(0, Number(limits.jitterMinutes ?? 20) || 0);
  // 只认合法的 HH:mm（25:99 这种要挡掉），再按时间先后排序，
  // 这样 perDay=1 时取到的一定是配置里最早的那个钟点，行为可预期。
  const times = (Array.isArray(limits.times) ? limits.times : [])
    .map((t) => /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()))
    .filter((m) => m && Number(m[1]) <= 23 && Number(m[2]) <= 59)
    .map((m) => Number(m[1]) * 60 + Number(m[2]))
    .sort((a, b) => a - b);

  const base = new Date(now);
  const out = [];
  if (times.length > 0) {
    for (let i = 0; i < perDay; i++) {
      const baseMinute = times[i % times.length];
      const jittered = baseMinute + (jitter > 0 ? Math.round((rand() * 2 - 1) * jitter) : 0);
      const d = new Date(base);
      d.setHours(0, 0, 0, 0);
      out.push(d.getTime() + Math.max(0, Math.min(24 * 60 - 1, jittered)) * 60000 + Math.floor(rand() * 60000));
    }
  } else {
    for (let i = 0; i < perDay; i++) out.push(pickTargetToday(now, limits));
  }
  return out.sort((a, b) => a - b);
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 拼提示词（纯函数，方便测试）。
 * recent 是最近发过的几条——重复自己是"不像活人"最明显的信号之一。
 */
export function buildPostPrompt(cfg, life, recent = [], now = new Date()) {
  const topics = cfg.style?.topics ?? [];
  const seed = topics.length ? pick(topics) : '今天的心情';
  const min = cfg.style?.minChars ?? 25;
  const max = cfg.style?.maxChars ?? 90;
  const stamp = `${now.getMonth() + 1}月${now.getDate()}日 ${weekdayOf(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines = [
    personaPrompt(cfg.persona),
    '',
    '你在自己的 QQ 空间发一条说说——不是回复谁，是你自己突然想发。',
    '',
    `【这次怎么写】${pick(STYLE_HINTS)}`,
    `【长度】${min}~${max} 字，按口语的字算，别写成作文`,
    `【时间】现在是 ${stamp}，${seasonOf(now)}的${(life && life.time) || timeOfDay(now)}`,
  ];
  if (life && life.lifeLine) lines.push(`【你现在在干嘛】${life.lifeLine}（只当背景，别写成流水账）`);
  if (recent.length > 0) {
    lines.push(`【最近发过】${recent.slice(-4).map((t) => `「${t}」`).join('')}——别重复这些的句式和开头`);
  }
  lines.push(
    '',
    '要求：',
    '- 像随手打的：可以只有半句、可以突然跳题、可以没头没尾',
    '- 只写一件事，不要起承转合，不要总结升华，不要给建议',
    '- 不解释你为什么发这条，不写"记录一下"这种话',
    `- 不要用这些开头：${BANNED_OPENERS.join('、')}`,
    `- 不要用这些书面词：${BANNED_WORDS.join('、')}`,
    '- 不要标题、不要话题标签、不要用引号把正文包起来',
    life && life.useEmoji
      ? `- 可以带一个表情符号（最多一个，从这些里选：${life.emoji || '🙃'}）`
      : '- 不用任何 emoji',
  );

  return {
    system: lines.join('\n'),
    user: `现在是 ${stamp}。可以想想：${seed}。直接写出说说正文。`,
  };
}

/** 清掉模型爱加的外壳：首尾引号、多余空行、结尾堆叠的省略号 */
export function cleanPostText(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[\s"'`「『（(\[]+/, '').replace(/[\s"'`」』）)\]]+$/, '').trim();
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[…\.]{4,}$/, '……');
  return text.trim();
}

async function generatePost(cfg, life, recent = []) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);

  const { system, user } = buildPostPrompt(cfg, life, recent);

  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.95 + Math.random() * 0.15,
      // deepseek-flash 是带推理的模型：思考过程会占用输出预算，
      // 上限给小了会导致 content 为空（reasoning 把 token 吃光）。
      max_tokens: 1600,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  const text = cleanPostText(doc?.choices?.[0]?.message?.content ?? '');
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

/** 按 config/qzone-life.json 的 images 段挑一张配图（没有就返回空数组） */
function pickImages(life) {
  const img = (life && life.images) || {};
  if (img.enabled !== true) return [];
  if (Math.random() >= Number(img.chance ?? 0.5)) return [];
  const dir = path.resolve(REPO, img.dir || 'refs/qzone');
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map((f) => path.join(dir, f));
    if (!files.length) { log(`配图目录里没有图片：${dir}`); return []; }
    return [pathToFileURL(pick(files)).href];
  } catch {
    return [];
  }
}

async function main() {
  const cfg = readJson(CFG_PATH);
  if (!cfg) fail(`读不到配置 ${CFG_PATH}`);

  // 本地覆盖：config/self-post.local.json（.gitignore 排除）里的 target/limits/style
  // 会覆盖主配置，用来存放私聊目标 QQ 这类个人信息。
  const localCfg = readJson(path.join(REPO, 'config', 'self-post.local.json'));
  if (localCfg && typeof localCfg === 'object') {
    cfg.target = Object.assign({}, cfg.target, localCfg.target || {});
    if (localCfg.limits) cfg.limits = Object.assign({}, cfg.limits, localCfg.limits);
    if (localCfg.style) cfg.style = Object.assign({}, cfg.style, localCfg.style);
    log('已加载 config/self-post.local.json 覆盖');
  }

  if (!cfg.enabled && !FORCE) { log('已关闭（self-post.json 里 enabled=false）'); return; }

  const now = Date.now();
  const today = dayKey(new Date(now));
  const state = readJson(STATE_PATH, {}) ?? {};

  // 每天重置：重新挑今天的时间点（指定钟点 + 随机浮动，或窗口内随机）
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.count = 0;
    state.targets = pickTargets(now, cfg.limits ?? {});
    delete state.targetAt; // 旧版字段，迁移后清掉
    writeJson(STATE_PATH, state);
    log(`新的一天，今日时间点：${state.targets.map(fmtClock).join('、')}`);
  }

  const limits = cfg.limits ?? {};
  const perDay = Number(limits.perDay ?? 1);
  const minGapMs = Number(limits.minGapHours ?? 18) * 3600 * 1000;
  const targets = Array.isArray(state.targets) && state.targets.length > 0 ? state.targets : [];

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
    // 今天第 N 条对应第 N 个时间点；时间点用完就按最后一个（配合 count 上限）
    const nextAt = Number(targets[Number(state.count ?? 0)] ?? targets[targets.length - 1] ?? 0);
    if (nextAt > 0 && now < nextAt) {
      log(`还没到今天的第 ${Number(state.count ?? 0) + 1} 个时间点（${fmtClock(nextAt)}）`);
      return;
    }
  }

  log('开始生成说说…');
  const shared = loadLife();
  const emo = shared.emoticons || {};
  const useEmoji = emo.enabled !== false && Math.random() < Number(emo.chance ?? 0.3);
  const life = {
    lifeLine: pick(shared.life),
    time: timeOfDay(),
    useEmoji,
    emoji: useEmoji ? pick(emo.list || ['🙃']) : '',
  };
  // 最近发过的内容：写进提示词，明确禁止重复句式和开头
  const recent = Array.isArray(state.recentPosts) ? state.recentPosts.slice(-6) : [];
  const text = await generatePost(cfg, life, recent);
  const images = pickImages(shared);
  log(`内容（${text.length} 字）：${text}`);
  if (images.length) log(`附带图片：${images[0]}`);
  if (DRY) { log('--dry，不发送'); return; }

  const url = cfg.napcat?.url ?? 'ws://127.0.0.1:3001';
  let delivered = 0;
  let lastError = null;
  let qzoneFailed = false;

  if (cfg.target?.qzone !== false) {
    try {
      const r = await callOneBot(url, 'send_qzone_msg', {
        content: text,
        ...(images.length ? { images } : {}),
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
  state.recentPosts = [...(Array.isArray(state.recentPosts) ? state.recentPosts : []), text].slice(-6);
  writeJson(STATE_PATH, state);
  log(`完成，今天第 ${state.count} 条`);
}

// 只有直接运行时才跑 main()：被测试 import 时不应该真去连 OneBot。
const isEntry = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main().catch((e) => { console.error(`[self-post] 失败：${e?.message ?? e}`); process.exit(1); });
