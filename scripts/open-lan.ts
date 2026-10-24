/**
 * 关闭 / 打开面板的局域网访问
 *
 *   node dist/scripts/open-lan.js            打开：host=0.0.0.0 + 生成 authToken（已有则沿用）
 *   node dist/scripts/open-lan.js --close    关闭：host=127.0.0.1 + 清空 authToken
 *   node dist/scripts/open-lan.js --show     只看当前状态
 *
 * 改的是 config/app.yaml 的 server 段，原子写入，需要重启 Agent 生效。
 * 面板里「扫码登录 → 开放局域网访问」按钮做的是同一件事，这里给不开面板的场合用。
 */
import crypto from 'node:crypto';
import { loadConfig, PROJECT_ROOT } from '../src/config/loader.js';
import { setConfigValues } from '../src/config/writer.js';
import { createLoginService } from '../src/server/login.js';
import path from 'node:path';

const file = path.join(PROJECT_ROOT, 'config', 'app.yaml');
const mode = process.argv.includes('--close') ? 'close'
  : process.argv.includes('--show') ? 'show'
    : 'open';

const { app: cfg } = loadConfig();
const login = createLoginService(cfg);

if (mode === 'show') {
  const urls = login.panelUrls(cfg.server.host, cfg.server.port);
  console.log(`host      : ${cfg.server.host}`);
  console.log(`port      : ${cfg.server.port}`);
  console.log(`authToken : ${cfg.server.authToken ? '(已设置，长度 ' + cfg.server.authToken.length + ')' : '(空)'}`);
  console.log(`NapCat dir: ${login.napcatDir}`);
  for (const u of urls) {
    console.log(`  ${u.label.padEnd(14)} ${u.url}  ${u.reachable ? '可访问' : '不可访问'}`);
  }
  process.exit(0);
}

if (mode === 'close') {
  setConfigValues(file, [
    [['server', 'host'], '127.0.0.1'],
    [['server', 'authToken'], ''],
  ]);
  console.log('已关闭局域网访问（host=127.0.0.1，authToken 清空）。重启 Agent 后生效。');
  process.exit(0);
}

const token = cfg.server.authToken || crypto.randomBytes(12).toString('hex');
const generated = !cfg.server.authToken;
setConfigValues(file, [
  [['server', 'host'], '0.0.0.0'],
  [['server', 'authToken'], token],
]);

console.log('已写入 config/app.yaml：');
console.log('  server.host      = 0.0.0.0');
console.log(`  server.authToken = ${token}${generated ? '  (本次生成)' : '  (沿用原有)'}`);
console.log('');
console.log('重启 Agent 后，用下面这些地址在手机上打开面板：');
for (const u of login.panelUrls('0.0.0.0', cfg.server.port)) {
  if (u.loopback) continue;
  console.log(`  ${u.label.padEnd(14)} ${u.url}`);
}
console.log('');
console.log('首次打开会提示输入 token，粘贴上面那一串。');
console.log('若手机打不开，通常是 Windows 防火墙拦了入站（见 README「网页扫码登录」）。');
