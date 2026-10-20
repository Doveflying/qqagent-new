// 用 VoiceStudio 生成市谷有咲的参考音（复刻到硅基流动用）
import fs from 'node:fs';

const TEXT = '当铺二楼的窗户开着，风把旧纸的味道吹进来。我把键盘靠在墙边，随手按了两个音，声音闷闷的。楼下有人来当东西，铃响了一声。懒得下去，这种情况，等一会儿再说。';
const OUT = 'refs/arisa-ref.wav';

const res = await fetch('http://127.0.0.1:3900/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'omnivoice', voice: 'cda9363f', input: TEXT, response_format: 'wav' }),
  signal: AbortSignal.timeout(180000),
});
if (!res.ok) {
  console.error('合成失败', res.status, (await res.text()).slice(0, 200));
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(OUT, buf);

// 读 WAV 头算时长
let seconds = 0;
if (buf.length > 44 && buf.subarray(0, 4).toString() === 'RIFF') {
  const ch = buf.readUInt16LE(22) || 1;
  const rate = buf.readUInt32LE(24) || 24000;
  const bits = buf.readUInt16LE(34) || 16;
  seconds = (buf.length - 44) / (rate * ch * (bits / 8));
}
console.log(`已生成 ${OUT}：${Math.round(buf.length / 1024)} KB，${seconds.toFixed(1)} 秒`);
console.log('文本长度', TEXT.length, '字');
if (seconds >= 30) console.log('⚠️ 超过 30 秒，需要裁剪后再复刻');
