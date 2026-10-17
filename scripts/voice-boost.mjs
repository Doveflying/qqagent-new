// 语音代理：日语化 + 响度归一 + 本地/云端回落。
//
// 链路：QQ Agent --(中文回复文本)--> 本代理
//         1. 用聊天模型把文本翻成日语口语（config/voice-proxy.json 的 translate）
//         2. 请求本地 VoiceStudio 合成；不可用时内部回落到云端 CosyVoice
//         3. 对 WAV 做前瞻限幅，把响度拉到适合 QQ 语音的水平
//        --> 返回音频给 QQ Agent
//
// 不改项目源码；所有开关都在 config/voice-proxy.json。
//
// 启动：node scripts/voice-boost.mjs
// 端口：127.0.0.1:3910

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CONFIG_PATH = process.env.VS_PROXY_CONFIG ?? path.join(REPO, 'config', 'voice-proxy.json');

const PORT = Number(process.env.VS_BOOST_PORT ?? 3910);
const HOST = '127.0.0.1';

const TARGET_RMS_DB = Number(process.env.VS_TARGET_RMS_DB ?? -9);
const CEIL = Number(process.env.VS_CEIL ?? 0.97);
const LOOKAHEAD_MS = Number(process.env.VS_LOOKAHEAD_MS ?? 5);
const RELEASE_MS = Number(process.env.VS_RELEASE_MS ?? 60);

// ---------------- 配置 ----------------

function loadProxyConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[voice] cannot read ${CONFIG_PATH}: ${e.message}`);
    return { translate: { enabled: false } };
  }
}

/** 从 config/providers.local.yaml（或 providers.yaml）读取供应商的 baseURL / apiKey。 */
function providerCreds(key) {
  if (!key) return null;
  for (const file of ['providers.local.yaml', 'providers.yaml']) {
    const full = path.join(REPO, 'config', file);
    if (!fs.existsSync(full)) continue;
    try {
      const doc = parseYaml(fs.readFileSync(full, 'utf8')) ?? {};
      const p = doc.providers?.[key];
      if (!p) continue;
      let apiKey = p.apiKey ?? '';
      if (!apiKey && p.apiKeyEnv) apiKey = process.env[p.apiKeyEnv] ?? '';
      return { baseURL: String(p.baseURL ?? '').replace(/\/+$/, ''), apiKey, protocol: p.protocol ?? 'openai' };
    } catch (e) {
      console.error(`[voice] cannot parse ${file}: ${e.message}`);
    }
  }
  return null;
}

let cfg = loadProxyConfig();
fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
  const next = loadProxyConfig();
  cfg = next;
  console.log('[voice] config reloaded');
});

// ---------------- 翻译 ----------------

const KANA = /[\u3040-\u30ff]/;
const CJK = /[\u4e00-\u9fff]/;

/** 语言码 → 提示词里用的名称。未列出的语言直接传代码给模型。 */
const LANG_NAMES = {
  ja: '日语', en: '英语', ko: '韩语', zh: '中文', fr: '法语', de: '德语',
  es: '西班牙语', ru: '俄语', pt: '葡萄牙语', it: '意大利语',
};

/** 中文（或混合文字）→ 目标语言口语。失败时返回原文，绝不阻断语音。 */
async function toTargetLanguage(text) {
  const target = String(cfg.translate?.target ?? 'ja').toLowerCase();
  if (!cfg.translate?.enabled || target === 'zh') return { text, skipped: 'disabled' };
  if (!CJK.test(text)) return { text, skipped: 'no-cjk' };
  // 已经是目标语言就别翻（只对能识别的情况做：日语用假名判断）
  if (target === 'ja' && KANA.test(text) && !/[的了是在我你他这那么吗呢吧]/.test(text)) {
    return { text, skipped: 'already-ja' };
  }

  const creds = providerCreds(cfg.translator?.providerKey);
  if (!creds?.apiKey) return { text, skipped: 'no-key' };

  const label = LANG_NAMES[target] ?? `语言代码为 ${target} 的语言`;
  const prompt =
    `你是同声传译。把用户给的中文聊天回复翻译成${label}，要求自然、口语化，` +
    '保留原有的语气、停顿和情绪。只输出译文本身，不要解释、不要引号、不要加原文。' +
    `如果原文已经是${label}，原样返回。`;

  const started = Date.now();
  try {
    const res = await fetch(`${creds.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        model: cfg.translator?.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[voice] translate HTTP ${res.status}: ${body.slice(0, 200)}`);
      return { text, skipped: `http-${res.status}` };
    }
    const doc = await res.json();
    const out = String(doc?.choices?.[0]?.message?.content ?? '').trim();
    if (!out) return { text, skipped: 'empty' };
    console.log(`[voice] 译(${Date.now() - started}ms): ${text.slice(0, 40)} → ${out.slice(0, 60)}`);
    return { text: out };
  } catch (e) {
    console.error(`[voice] translate failed: ${e?.message ?? e}`);
    return { text, skipped: 'error' };
  }
}

// ---------------- 音频处理 ----------------

function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      const start = offset + 8;
      const len = Math.min(size === 0 ? buf.length - start : size, buf.length - start);
      return { fmt, dataOffset: start, dataLen: len };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function rmsOf(arr, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, n));
}

function peakOf(arr, n) {
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(arr[i]);
    if (a > p) p = a;
  }
  return p;
}

function limiterGains(x, n, sr) {
  const look = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sr));
  const relCoef = Math.exp(-1 / ((RELEASE_MS / 1000) * sr));

  const want = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    want[i] = a > CEIL ? CEIL / a : 1;
  }

  const g = new Float32Array(n);
  const deque = [];
  let right = -1;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + look);
    while (right < end) {
      right++;
      while (deque.length && want[deque[deque.length - 1]] >= want[right]) deque.pop();
      deque.push(right);
    }
    while (deque.length && deque[0] < i) deque.shift();
    g[i] = deque.length ? want[deque[0]] : 1;
  }

  let env = 1;
  for (let i = 0; i < n; i++) {
    if (g[i] < env) env = g[i];
    else env = relCoef * env + (1 - relCoef) * g[i];
    g[i] = env;
  }
  return g;
}

function normalize(buf) {
  const parsed = parseWav(buf);
  if (!parsed || !parsed.fmt) return { note: 'not-wav' };
  if (parsed.fmt.bits !== 16) return { note: `bits=${parsed.fmt.bits}` };

  const { dataOffset, dataLen, fmt } = parsed;
  const count = Math.floor(dataLen / 2);
  if (count <= 0) return { note: 'empty' };

  const src = new Float32Array(count);
  for (let i = 0; i < count; i++) src[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;

  const beforeRms = rmsOf(src, count);
  if (beforeRms < 1e-6) return { note: 'silent' };
  const beforeDb = 20 * Math.log10(beforeRms);
  const sr = fmt.sampleRate || 24000;
  const target = Math.pow(10, TARGET_RMS_DB / 20);

  const out = new Float32Array(count);
  let makeup = 1;
  let lastRms = beforeRms;

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < count; i++) out[i] = src[i] * makeup;
    const gains = limiterGains(out, count, sr);
    for (let i = 0; i < count; i++) {
      let v = out[i] * gains[i];
      if (v > CEIL) v = CEIL; else if (v < -CEIL) v = -CEIL;
      out[i] = v;
    }
    lastRms = rmsOf(out, count);
    if (lastRms <= 0) break;
    const correction = target / lastRms;
    if (Math.abs(correction - 1) < 0.02) break;
    makeup *= Math.min(8, Math.max(0.5, correction));
  }

  for (let i = 0; i < count; i++) {
    let v = out[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    buf.writeInt16LE(Math.round(v * 32767), dataOffset + i * 2);
  }

  const afterDb = 20 * Math.log10(Math.max(lastRms, 1e-9));
  return {
    note: `rms ${beforeDb.toFixed(1)}->${afterDb.toFixed(1)}dB peak=${peakOf(out, count).toFixed(2)} makeup=${makeup.toFixed(2)}x`,
  };
}

// ---------------- 上游合成 ----------------

async function synthLocal(payload) {
  const base = String(cfg.local?.baseURL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('local baseURL missing');
  const body = { ...payload, response_format: 'wav' };
  if (cfg.local?.language) body.language = cfg.local.language;
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`local ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function synthCloud(payload) {
  const cloud = cfg.cloud ?? {};
  const creds = providerCreds(cloud.providerKey);
  if (!creds?.apiKey) throw new Error('cloud provider key missing');
  const body = {
    model: cloud.model,
    input: payload.input,
    voice: cloud.voice,
    response_format: 'wav',
    speed: payload.speed ?? 1,
  };
  const res = await fetch(`${creds.baseURL}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------- HTTP ----------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    const out = { ok: false, translate: !!cfg.translate?.enabled, local: false, cloud: false };
    try {
      const r = await fetch(`${String(cfg.local?.baseURL ?? '').replace(/\/+$/, '')}/v1/audio/voices`, {
        signal: AbortSignal.timeout(3000),
      });
      out.local = r.ok;
      if (r.ok) {
        const doc = await r.json();
        out.voices = (doc.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, type: v.type }));
      }
    } catch { /* local down */ }
    out.cloud = !!providerCreds(cfg.cloud?.providerKey)?.apiKey;
    out.ok = out.local || (out.cloud && cfg.cloud?.enabled !== false);
    return sendJson(res, out.ok ? 200 : 503, out);
  }

  if (req.method === 'POST' && url.startsWith('/v1/audio/speech')) {
    const started = Date.now();
    try {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (typeof payload.input !== 'string' || !payload.input.trim()) {
        return sendJson(res, 400, { error: 'input required' });
      }

      const original = payload.input;
      const translated = await toTargetLanguage(original);
      payload.input = translated.text;
      payload.response_format = 'wav';

      let audio;
      let via;
      try {
        audio = await synthLocal(payload);
        via = 'local';
      } catch (localErr) {
        if (cfg.cloud?.enabled === false) throw localErr;
        audio = await synthCloud(payload);
        via = 'cloud';
        console.log(`[voice] local failed (${localErr.message}), used cloud`);
      }

      const info = normalize(audio);
      res.writeHead(200, {
        'Content-Type': audio.toString('ascii', 0, 4) === 'RIFF' ? 'audio/wav' : 'application/octet-stream',
        'Content-Length': audio.length,
        'X-Voice-Boost': encodeURIComponent(info.note),
        'X-Voice-Via': via,
        'X-Voice-Translated': translated.skipped ? `skipped:${translated.skipped}` : 'yes',
        // 便于核对翻译结果（URL 编码，避免非 ASCII 头部问题）
        'X-Voice-Text': encodeURIComponent(payload.input.slice(0, 200)),
      });
      res.end(audio);
      console.log(
        `[voice] ${via} ${audio.length}B ${info.note} ` +
          `translated=${translated.skipped ? 'skip(' + translated.skipped + ')' : 'yes'} ${Date.now() - started}ms`,
      );
    } catch (e) {
      console.error('[voice] failed:', e?.message ?? e);
      if (!res.headersSent) sendJson(res, 502, { error: String(e?.message ?? e) });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log(`[voice] port ${PORT} already in use, another instance is running - exiting`);
    process.exit(0);
  }
  console.error('[voice] server error:', e?.message ?? e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const t = cfg.translate?.enabled ? `translate→${cfg.translate.target}` : 'translate=off';
  console.log(`[voice] http://${HOST}:${PORT} local=${cfg.local?.baseURL ?? '-'} cloud=${cfg.cloud?.baseURL ?? '-'} ${t} target ${TARGET_RMS_DB}dBFS`);
});
