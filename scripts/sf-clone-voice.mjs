// 在硅基流动复刻她的音色（上传参考音频 → 拿到 uri → 写进语音配置）
//
//   node scripts/sf-clone-voice.mjs --dry
//   node scripts/sf-clone-voice.mjs --ref refs/voice-cn.wav --name shiori --write
//
// 硅基流动的 TTS 用不了 VoiceStudio 的 profile id（那是本地 omnivoice 的编号），
// 但支持「上传参考音频」做零样本复刻：POST /v1/uploads/audio/voice
// 返回形如 speech:shiori:xxx:xxx 的 uri，把它当作 /v1/audio/speech 的 voice 即可。
//
// --text      参考音频里说的原话；不给就用 SenseVoice 转写
// --write     把拿到的 uri 写进 config/speech-backend.json 的 cloud.voice

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'speech-backend.json');

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DRY = args.includes('--dry');
const WRITE = args.includes('--write');

function log(m) { console.log(`[clone] ${m}`); }
function fail(m) { console.error(`[clone] ${m}`); process.exit(1); }

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

const creds = providerCreds('siliconflow');
if (!creds?.apiKey) fail('没找到 siliconflow 的 API Key（config/providers.local.yaml）');

const refPath = path.resolve(arg('ref', fs.existsSync(path.join(REPO, 'refs', 'voice-cn.wav'))
  ? path.join(REPO, 'refs', 'voice-cn.wav')
  : path.join(REPO, 'refs', 'voice.wav')));
const customName = arg('name', 'shiori');
const model = arg('model', 'FunAudioLLM/CosyVoice2-0.5B');
const asrModel = arg('asr-model', 'FunAudioLLM/SenseVoiceSmall');

if (!fs.existsSync(refPath)) fail(`参考音频不存在：${refPath}`);
const refBytes = fs.readFileSync(refPath);
log(`参考音频：${path.relative(REPO, refPath)}（${Math.round(refBytes.length / 1024)} KB）`);
log(`复刻模型：${model}   名称：${customName}`);

/** 用 SenseVoice 转写参考音频，拿到"对应文本"——上传接口这个字段是必需的。 */
async function transcribe() {
  const form = new FormData();
  form.append('file', new Blob([refBytes], { type: 'audio/wav' }), path.basename(refPath));
  form.append('model', asrModel);
  const res = await fetch(`${creds.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`转写失败 ${res.status}: ${text.slice(0, 300)}`);
  const raw = (() => { try { return String(JSON.parse(text).text ?? ''); } catch { return text; } })();
  // SenseVoice 偶尔在结尾吐出表情符号或半句别的语言，清掉再拿去复刻
  return raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
}

async function upload(text) {
  const form = new FormData();
  form.append('file', new Blob([refBytes], { type: 'audio/wav' }), path.basename(refPath));
  form.append('model', model);
  form.append('customName', customName);
  form.append('text', text);
  const res = await fetch(`${creds.baseURL}/uploads/audio/voice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`上传失败 ${res.status}: ${body.slice(0, 400)}`);
  const doc = JSON.parse(body);
  return String(doc.uri ?? doc.voice ?? '');
}

const main = async () => {
  let text = arg('text');
  if (!text) {
    log('没给 --text，先用 SenseVoice 转写参考音频…');
    text = await transcribe();
    if (!text) fail('转写结果为空，请手动用 --text 给出参考音频的原话');
    log(`转写结果：${text}`);
  }
  if (DRY) { log(`[dry] 将以文本「${text}」上传复刻，不实际调用`); return; }

  const uri = await upload(text);
  if (!uri) fail('接口没返回 uri');
  log(`复刻完成，音色 uri：${uri}`);

  if (WRITE) {
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    cfg.cloud = { ...(cfg.cloud ?? {}), model, voice: uri };
    fs.writeFileSync(CFG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    log(`已写入 config/speech-backend.json 的 cloud.voice`);
  } else {
    log(`要写进配置就重跑并加 --write，或手动设 cloud.voice = ${uri}`);
  }
};

main().catch((e) => fail(e?.message ?? String(e)));
