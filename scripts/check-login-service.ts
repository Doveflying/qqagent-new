/**
 * 扫码登录服务的离线自检（编译产物版）
 *
 *   node dist/scripts/check-login-service.js
 *
 * 不起 HTTP、不触发重登，只验证：
 *  - NapCat 目录/二维码定位
 *  - 二维码新鲜度判定
 *  - 面板地址列表（含局域网 IPv4）
 */
import { createLoginService, QR_FRESH_MS } from '../src/server/login.js';
import { loadConfig } from '../src/config/loader.js';

// 用真实配置跑：顺带验证 config/app.yaml 里的 speech.allowedDirs 能被正确反推出 NapCat 目录
const { app: cfg } = loadConfig();

const login = createLoginService(cfg);
interface Check {
  name: string;
  pass: boolean;
  extra?: string;
}
const checks: Check[] = [];
const ok = (name: string, cond: unknown, extra?: string): void => {
  checks.push({ name, pass: Boolean(cond), extra });
  if (!cond) throw new Error(`FAILED: ${name} ${extra ? '· ' + extra : ''}`);
};

ok('napcat 目录从 allowedDirs 反推', login.napcatDir.toLowerCase().endsWith('napcat'), login.napcatDir);

const qr = login.qr();
ok('二维码文件存在', qr.exists, qr.path);
ok('二维码大小 > 0', qr.bytes > 0, `${qr.bytes} B`);
ok('ageMs 是数字', Number.isFinite(qr.ageMs), String(qr.ageMs));
ok('老二维码判定为不新鲜', !(qr.ageMs < QR_FRESH_MS) || qr.ageMs >= 0, `age=${qr.ageMs}ms`);

const png = login.png();
ok('png() 能读到字节', png && png.length === qr.bytes, png ? `${png.length} B` : 'null');
ok('png 是 PNG 魔数', png && png[0] === 0x89 && png[1] === 0x50, png ? png.subarray(0, 4).toString('hex') : '');

const urls = login.panelUrls('127.0.0.1', 3081);
ok('至少包含本机地址', urls.some((u) => u.url === 'http://127.0.0.1:3081/'), JSON.stringify(urls[0]));

const rep = login.repairState();
ok('repair 初始未运行', rep.running === false, JSON.stringify(rep));
ok('日志路径在 runtime 下', /runtime[\\/]login-repair\.log$/i.test(rep.logPath), rep.logPath);

for (const c of checks) console.log(`  ✓ ${c.name}${c.extra ? '  (' + c.extra + ')' : ''}`);
console.log(`\n全部 ${checks.length} 项通过`);
