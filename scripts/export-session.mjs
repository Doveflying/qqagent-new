// 把 DSH 会话（多帧 zstd + JSONL）导出成可读的 Markdown + 原始 JSONL
//
//   node scripts/export-session.mjs <session.v3.jsonl.zstd> <输出目录>
//
// 会话文件是**一串独立 zstd 帧首尾相接**（每次追加写一帧）。
// Node 的 zstd 解压只认第一帧，所以要按帧头/块头自己算帧长，再逐帧解。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = 0xfd2fb528; // zstd 帧魔数（小端 28 B5 2F FD）

function frameLength(buf, start) {
  if (buf.readUInt32LE(start) !== MAGIC) throw new Error(`不是 zstd 帧 @${start}`);
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = (fhd >> 6) & 0x3;
  const singleSegment = (fhd >> 5) & 0x1;
  const hasChecksum = (fhd >> 2) & 0x1;
  const dictFlag = fhd & 0x3;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 0x3;
    const size = h >>> 3;
    p += type === 1 ? 1 : size;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p - start;
}

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('用法：node scripts/export-session.mjs <session.v3.jsonl.zstd> <输出目录>');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const frames = [];
let off = 0;
while (off < buf.length) {
  const len = frameLength(buf, off);
  frames.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)));
  off += len;
}
const raw = Buffer.concat(frames).toString('utf8');
const records = raw.split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

fs.mkdirSync(outDir, { recursive: true });
const meta = records.find((r) => r.type === 'session') ?? {};
const id = meta.id ?? path.basename(path.dirname(file));
const stem = `session-${String(id).replace(/^session-/, '')}`;

// 原始 JSONL 一并留档，方便以后重新渲染或做搜索
fs.writeFileSync(path.join(outDir, `${stem}.jsonl`), raw, 'utf8');

// ---- 渲染 Markdown ----
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => c.text)
    .join('\n')
    .trim();
};
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');

const md = [];
md.push(`# 会话记录 · ${id}`);
md.push('');
if (meta.cwd) md.push(`- 工作目录：\`${meta.cwd}\``);
if (meta.createdAt) md.push(`- 开始时间：${fmtTime(meta.createdAt)}`);
if (meta.agentPreset) md.push(`- 预设：${meta.agentPreset}`);
md.push(`- 记录数：${records.length}`);
md.push('');
md.push('---');
md.push('');

let currentTurn = 0;
for (const r of records) {
  const d = r.data ?? {};
  switch (r.type) {
    case 'turn/start':
      currentTurn = (currentTurn ?? 0) + 1;
      md.push(`\n### 第 ${currentTurn} 轮 · ${fmtTime(r.time)}\n`);
      break;
    case 'user/message': {
      const t = textOf(d.content);
      if (t) md.push(`**👤 我**\n\n${t}\n`);
      break;
    }
    case 'assistant/message': {
      const t = textOf(d.message?.content);
      if (t) md.push(`**🤖 YG**\n\n${t}\n`);
      break;
    }
    case 'tool/call': {
      let args = '';
      try { args = JSON.stringify(JSON.parse(d.arguments ?? '{}')); } catch { args = String(d.arguments ?? ''); }
      const brief = args.length > 220 ? `${args.slice(0, 220)}…` : args;
      md.push(`> 🔧 \`${d.name}\` ${brief}`);
      break;
    }
    case 'deliverables/presented': {
      const files = (d.deliverables ?? d.files ?? []).map((f) => f.path ?? f).filter(Boolean);
      if (files.length) md.push(`> 📎 交付：${files.join('、')}`);
      break;
    }
    case 'compaction/summary': {
      const t = textOf(d.summary ?? d.content ?? d.text);
      if (t) md.push(`\n> **（上下文压缩摘要）**\n>\n> ${t.replace(/\n/g, '\n> ')}\n`);
      break;
    }
    default:
      break;
  }
}

const mdPath = path.join(outDir, `${stem}.md`);
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

fs.writeFileSync(path.join(outDir, 'README.md'), [
  '# 会话导出说明',
  '',
  `- \`${stem}.md\`：整理过的对话（我 / YG 的发言 + 工具调用摘要 + 交付文件）`,
  `- \`${stem}.jsonl\`：解压后的原始记录，每条一个 JSON，包含全部工具调用与结果`,
  '',
  '原始文件是 `session.v3.jsonl.zstd`，由多个 zstd 帧首尾相接组成，',
  '直接 `zstd -d` 只会解出第一帧；这里按帧头/块头算出每帧长度后逐帧解压。',
  '',
  `- 会话 ID：\`${id}\``,
  `- 记录条数：${records.length}`,
  `- 导出方式：\`node scripts/export-session.mjs <session.v3.jsonl.zstd> <目录>\``,
].join('\n'), 'utf8');

console.log(`帧 ${frames.length}，记录 ${records.length}`);
console.log(`已写出：${mdPath}`);
console.log(`已写出：${path.join(outDir, `${stem}.jsonl`)}`);
