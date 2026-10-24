// 在服务器上实测视频抽帧：node deploy/test-video.mjs /tmp/t.mp4
import { collectVideoFrames, parseVideoSegments } from '/opt/qqagent/dist/src/llm/video.js';

const file = process.argv[2] || '/tmp/t.mp4';
const t0 = Date.now();
const res = await collectVideoFrames(
  [{ type: 'video', data: { file } }],
  { allowedDirs: ['/tmp'], timeoutMs: 20000 },
);
console.log('耗时:', Date.now() - t0, 'ms');
console.log('帧数:', res.images.length);
console.log('每帧字节:', res.images.map((i) => i.bytes).join(', '));
console.log('mime:', res.images.map((i) => i.part.mimeType).join(', '));
console.log('notes:', res.notes);
console.log('errors:', res.errors);
console.log('parseVideoSegments 自检:', parseVideoSegments(JSON.stringify([{ type: 'video', data: { url: 'x' } }])).length);
process.exit(res.images.length > 0 ? 0 : 1);
