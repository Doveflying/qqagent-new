/**
 * 扫码登录接口自检（不打端口、不触发重登、不起子进程）
 *
 *   node dist/scripts/check-login-routes.js
 *
 * 用真实 createServer + 真实 config/app.yaml，用 Hono 的 app.request() 直接打路由：
 *  - GET /api/login/status  结构、二维码新鲜度、面板地址
 *  - GET /api/login/qr      真的吐出 PNG 字节
 *  - GET /api/login/log     修复日志接口
 *  - GET /                   面板 HTML 里确实有「扫码登录」页
 */
import { createServer } from '../src/server/api.js';
import { loadConfig, PROJECT_ROOT } from '../src/config/loader.js';
import { setConfigValues } from '../src/config/writer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { app: cfg } = loadConfig();

const noop = (): void => {};
const log = {
  info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
  child: () => log,
};

const fakeStatement = {
  all: () => [],
  get: () => null,
  run: () => ({ changes: 0 }),
};
const deps = {
  cfg,
  store: { db: { prepare: () => fakeStatement }, embeddingStats: () => ({ total: 0, models: [] }) },
  providers: {},
  personas: {},
  log,
  runtime: () => ({
    napcatConnected: false,
    selfId: 0,
    nickname: '',
    uptimeMs: 1000,
    startedAt: Date.now() - 1000,
    onebot: {
      connected: false, accountReady: false, apiReady: false, generation: 1,
      pending: 0, bufferedBytes: 0,
      implementation: { name: 'mock', version: '0.0.0', protocol: 'v11' },
      extensions: {},
    },
  }),
  updateDefaultModel: noop,
  saveProvider: noop,
  deleteProvider: noop,
  reloadPersonas: () => 0,
  setDefaultPersona: noop,
  savePersona: noop,
  deletePersona: noop,
  updateSettings: () => 0,
  updateAccess: () => 0,
  testEmbedding: async () => ({ ok: false, dim: 0, latencyMs: 0 }),
  embeddingStats: () => ({ total: 0, models: [] }),
  runtimeDetail: () => ({
    emotion: { mode: 'off', providerKey: '', modelId: '' },
    facts: { providerKey: '', modelId: '' },
    roles: [],
    semanticReady: false,
    vision: { ok: false, provider: '', model: '' },
  }),
};

// ---------- 结构断言 ----------
interface Check {
  name: string;
  pass: boolean;
  extra?: string;
}
const results: Check[] = [];
function ok(name: string, cond: unknown, extra?: string): void {
  results.push({ name, pass: Boolean(cond), extra });
  if (!cond) throw new Error(`FAILED: ${name}${extra ? ' · ' + extra : ''}`);
}

const server = createServer(deps as never);
const app = server.app;

// 1) 状态接口
const r1 = await app.request('/api/login/status');
ok('status 返回 200', r1.status === 200, `HTTP ${r1.status}`);
const s = await r1.json();
ok('status.ok', s.ok === true);
ok('connected 是布尔', typeof s.connected === 'boolean', String(s.connected));
ok('qr 结构完整', s.qr && 'exists' in s.qr && 'fresh' in s.qr && 'url' in s.qr, JSON.stringify(s.qr));
ok('qr.url 指向二维码接口', typeof s.qr.url === 'string' && s.qr.url.startsWith('/api/login/qr?ts='), s.qr.url);
ok('napcatDir 已解析', typeof s.napcatDir === 'string' && /napcat/i.test(s.napcatDir), s.napcatDir);
ok('panel.urls 含本机地址', Array.isArray(s.panel.urls) && s.panel.urls.some((u: { url: string }) => /127\.0\.0\.1/.test(u.url)), JSON.stringify(s.panel.urls));
ok('panel.loopbackOnly 为 true', s.panel.loopbackOnly === true, String(s.panel.loopbackOnly));
ok('repair 未运行', s.repair && s.repair.running === false);

// 2) 二维码接口
const r2 = await app.request('/api/login/qr');
const ctype = r2.headers.get('content-type') || '';
if (s.qr.exists) {
  ok('qr 返回 200', r2.status === 200, `HTTP ${r2.status}`);
  ok('content-type 是 png', ctype.includes('image/png'), ctype);
  const bytes = new Uint8Array(await r2.arrayBuffer());
  ok('字节非空', bytes.length > 0, `${bytes.length} B`);
  ok('是 PNG 魔数', bytes[0] === 0x89 && bytes[1] === 0x50, [...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' '));
  ok('带 no-store', (r2.headers.get('cache-control') || '').includes('no-store'), r2.headers.get('cache-control') || '');
} else {
  ok('无二维码时返回 404 JSON', r2.status === 404, `HTTP ${r2.status}`);
}

// 3) 日志接口
const r3 = await app.request('/api/login/log');
ok('log 返回 200', r3.status === 200);
const l = await r3.json();
ok('log 有 repair 字段', l && typeof l.repair === 'object' && typeof l.log === 'string');

// 4) 面板 HTML 里有新页面
const r4 = await app.request('/');
ok('面板返回 200', r4.status === 200);
const html = await r4.text();
ok('导航里有「扫码登录」', html.includes('data-page="login"'));
ok('页面容器存在', html.includes('id="page-login"'));
ok('二维码图片元素存在', html.includes('id="loginQrImg"'));
ok('loadLogin 已接入', html.includes('function loadLogin'));
ok('PAGE_TITLES 收录 login', html.includes("login:'扫码登录'"));
ok('刷新分发接入 login', html.includes('login: () => loadLogin()'));
ok('局域网按钮存在', html.includes('id="loginLanBtn"'));

// 面板内联脚本必须能解析：重复声明、括号不配对这类错误 node --check 才发现
const scriptBody = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
let scriptError = '';
try {
  // new Function 只解析不执行，足够抓语法错误
  new Function(scriptBody);
} catch (e) {
  scriptError = (e as Error).message;
}
ok('面板脚本语法可解析', !scriptError, scriptError);

// 5) open-lan 只接受 POST（GET 不该成功），且真的不改本机配置
const r5 = await app.request('/api/login/open-lan');
ok('open-lan 拒绝 GET', r5.status !== 200, `HTTP ${r5.status}`);

// 6) 用 config/app.yaml 的临时副本验证「写 host + token」不会把 YAML 写坏
const tmpYaml = path.join(os.tmpdir(), `qa-app-${process.pid}-${Date.now()}.yaml`);
fs.copyFileSync(path.join(PROJECT_ROOT, 'config', 'app.yaml'), tmpYaml);
setConfigValues(tmpYaml, [
  [['server', 'host'], '0.0.0.0'],
  [['server', 'authToken'], 'deadbeefcafe1234'],
]);
const written = fs.readFileSync(tmpYaml, 'utf8');
const serverBlock = written.split(/^server:/m)[1]?.split(/^\S/m)[0] ?? '';
ok('副本里 host 已改写', /host:\s*"?0\.0\.0\.0"?/.test(serverBlock), serverBlock.trim().split('\n')[1] ?? '');
ok('副本里 token 已写入', /authToken:\s*"?deadbeefcafe1234"?/.test(serverBlock));
ok('副本其余配置仍在', written.includes('dbPath: data/brain.db') && written.includes('napcat:'));
fs.unlinkSync(tmpYaml);

// 真实配置必须没被这次自检动过
const realYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'app.yaml'), 'utf8');
ok('真实配置未被修改', /server:[\s\S]{0,120}host:\s*"?127\.0\.0\.1"?/.test(realYaml));

// 7) 空间动态接口：GET 结构 + POST 往返（把现有配置原样写回，验证校验不丢字段）
const rq1 = await app.request('/api/qzone');
ok('qzone GET 200', rq1.status === 200, `HTTP ${rq1.status}`);
const qz = (await rq1.json()) as { path: string; config: Record<string, any> };
ok('qzone 返回 path/config', typeof qz.path === 'string' && !!qz.config && typeof qz.config === 'object');
const watch0: Array<{ uin: number; name?: string }> = Array.isArray(qz.config?.['watch']) ? qz.config['watch'] : [];
if (watch0.length > 0) {
  const rq2 = await app.request('/api/qzone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(qz.config),
  });
  ok('qzone POST 200', rq2.status === 200, `HTTP ${rq2.status}`);
  const saved = JSON.parse(fs.readFileSync(qz.path, 'utf8')) as Record<string, any>;
  ok('白名单往返不丢', Array.isArray(saved['watch'])
    && saved['watch'].some((w: { uin: number }) => Number(w.uin) === Number(watch0[0]!.uin)),
  JSON.stringify(saved['watch']));
  ok('配额字段保留', saved['limits'] && typeof saved['limits'].perDay === 'number', JSON.stringify(saved['limits']));
  ok('回复评论配置保留', saved['replyComments'] && Array.isArray(saved['replyComments'].watch),
    JSON.stringify(saved['replyComments']?.watch));
}
const rqRun = await app.request('/api/qzone/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
ok('qzone run 路由已注册', rqRun.status === 200 || rqRun.status === 500, `HTTP ${rqRun.status}`);

// 8) 她的日常（life/emoticons/images）：GET + 往返写入
const rl1 = await app.request('/api/qzone/life');
ok('life GET 200', rl1.status === 200, `HTTP ${rl1.status}`);
const lf = (await rl1.json()) as { path: string; config: Record<string, any> };
ok('life 返回 config', !!lf.config && typeof lf.config === 'object');
const life0 = Array.isArray(lf.config?.['life']) ? lf.config['life'] : [];
if (life0.length > 0) {
  const rl2 = await app.request('/api/qzone/life', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lf.config),
  });
  ok('life POST 200', rl2.status === 200, `HTTP ${rl2.status}`);
  const savedLife = JSON.parse(fs.readFileSync(lf.path, 'utf8')) as Record<string, any>;
  ok('日常池往返不丢', Array.isArray(savedLife['life']) && savedLife['life'].length === life0.length, `${savedLife['life']?.length ?? 0} 条`);
  ok('表情/配图配置保留', !!savedLife['emoticons'] && typeof savedLife['emoticons'].chance === 'number' && !!savedLife['images']);
}

for (const r of results) console.log(`  ✓ ${r.name}${r.extra ? '  (' + r.extra + ')' : ''}`);
console.log(`\n全部 ${results.length} 项通过`);
