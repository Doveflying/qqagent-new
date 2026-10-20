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

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const FORCE = args.has('--force');

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
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stripTags(html) {
  return String(html ?? '')
    .replace(/\[em\]e\d+\[\/em\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

/** 读某人最近的说说 */
async function listPosts(s, uin, num = 5) {
  const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
    + `?uin=${uin}&ftype=0&sort=0&pos=0&num=${num}&replynum=0&g_tk=${s.gtk}`
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
    uin: Number(m.uin ?? uin),
    content: stripTags(m.content),
    createdAt: Number(m.created_time ?? 0) * 1000,
    commentCount: Number(m.cmntnum ?? m.commentlist?.length ?? 0),
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

async function generateComment(cfg, post, who) {
  const creds = providerCreds(cfg.llm?.providerKey);
  if (!creds?.apiKey) throw new Error(`供应商 ${cfg.llm?.providerKey} 没有可用的 API Key`);
  const min = cfg.style?.minChars ?? 3;
  const max = cfg.style?.maxChars ?? 30;
  const system = [
    personaPrompt(cfg.persona),
    '',
    `你在 QQ 空间看到${who || '对方'}发了一条动态，要评论一句。`,
    `要求：${min}~${max} 字，一句话，口语，别客套，别用 emoji；`,
    '像随手打的，可以吐槽、可以接他的话、可以只评价其中某个细节；不要问一堆问题。',
    '直接输出评论正文。',
  ].join('\n');
  const res = await fetch(`${creds.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm?.model || 'deepseek-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `动态内容：${post.content.slice(0, 500)}\n\n写一句评论。` },
      ],
      temperature: 0.95,
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

async function main() {
  const cfg = readJson(CFG_PATH);
  if (!cfg) fail(`读不到配置 ${CFG_PATH}`);
  const watch = (cfg.watch ?? []).filter((w) => Number.isFinite(Number(w?.uin)));
  if (watch.length === 0) fail('config/qzone-reply.json 的 watch 里没有要回复的人');
  if (!cfg.enabled && !FORCE) { log('已关闭（enabled=false）'); return; }

  const now = Date.now();
  const today = dayKey(new Date(now));
  const state = readJson(STATE_PATH, {}) ?? {};
  state.dayKey ??= today;
  state.seen ??= {};
  state.count ??= 0;
  if (state.dayKey !== today) { state.dayKey = today; state.count = 0; }

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

  let acted = 0;
  for (const w of watch) {
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
      try { text = await generateComment(cfg, post, w.name); }
      catch (e) { log(`生成评论失败：${e.message}`); continue; }
      log(`${w.name || uin} 新动态（${new Date(post.createdAt).toLocaleString('zh-CN')}）：${post.content.slice(0, 40)}`);
      log(`  → 评论：${text}`);

      if (DRY) { seen.push(post.tid); continue; }
      try {
        await comment(s, uin, post.tid, text);
        seen.push(post.tid);
        state.count += 1;
        state.lastAt = Date.now();
        state.lastText = text;
        acted += 1;
        log(`  ✓ 已评论`);
      } catch (e) {
        log(`  ✗ ${e.message}`);
        state.failCount = Number(state.failCount ?? 0) + 1;
        state.lastAttemptAt = Date.now();
      }
      if (state.count >= perDay) break;
    }
    state.seen[uin] = seen.slice(-100);
  }

  // dry 不落盘：否则试跑一次就把这些 tid 记成"已回复"，之后真跑什么都不做
  if (!DRY) writeJson(STATE_PATH, state);
  log(`完成，本次评论 ${acted} 条，今天共 ${state.count} 条`);
}

main().catch((e) => { console.error(`[qzone] 失败：${e?.message ?? e}`); process.exit(1); });
