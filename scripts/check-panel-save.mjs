/**
 * 面板「空间动态 → 保存」的真实执行测试（假 DOM）
 *
 *   node scripts/check-panel-save.mjs [panel 地址]
 *
 * 做法：把 src/web/panel.html 里的内联脚本抽出来，在一个最小 DOM shim 里执行，
 * 然后真的调用 saveQzone()，走真实 fetch 打到运行中的面板。
 * 这样能区分「后端/代码有问题」和「你浏览器里是旧页面」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:3081';

const html = fs.readFileSync(path.join(REPO, 'src', 'web', 'panel.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) { console.error('没找到内联脚本'); process.exit(1); }

// ---- 最小 DOM shim ----
const els = new Map();
function el(id) {
  if (!els.has(id)) {
    els.set(id, {
      id, value: '', checked: false, textContent: '', innerHTML: '',
      style: {}, dataset: {}, disabled: false,
      addEventListener() {}, removeEventListener() {}, classList: { toggle() {}, add() {}, remove() {} },
      appendChild() {}, focus() {}, removeAttribute() {}, setAttribute() {},
    });
  }
  return els.get(id);
}
const document = {
  getElementById: (id) => el(id),
  createElement: () => {
    const node = el(`__created_${Math.random().toString(36).slice(2)}`);
    node.appendChild = () => {};
    node.remove = () => {};
    node.classList = { add() {}, remove() {}, toggle() {} };
    return node;
  },
  body: { appendChild() {}, removeChild() {} },
  querySelectorAll: () => [],
  addEventListener: () => {},
  title: '',
};
const window = { addEventListener: () => {}, location: { hash: '' } };
const location = { hash: '' };
const history = { replaceState: () => {} };
const sessionStorage = { getItem: () => null, setItem: () => {} };

const realFetch = globalThis.fetch;
const fetchShim = (url, opts) => realFetch(String(url).startsWith('http') ? url : BASE + url, opts);

const fn = new Function(
  'document', 'window', 'location', 'history', 'sessionStorage', 'fetch', 'console',
  `${script}
   return { saveQzone, saveLife, loadQzone, loadQzoneLife, qzParseWatch, qzFormatWatch, QZ_BUILD };`,
);
const scope = fn(document, window, location, history, sessionStorage, fetchShim, console);

console.log('页面 build:', scope.QZ_BUILD);

// 先记下原始配置，测试结束后原样还原
const original = await (await realFetch(`${BASE}/api/qzone`)).json();

// ---- 填表单并调用真实保存 ----
el('qz_watch_text').value = '2731758714 黄昏\n123456789 测试同学';
el('qz_enabled').checked = true;
el('qz_persona').value = 'shiori';
el('qz_provider').value = 'deepseek';
el('qz_model').value = 'deepseek-flash';
el('qz_perDay').value = 2;
el('qz_minGap').value = 30;
el('qz_maxAgeDays').value = 2;
el('qz_scanPosts').value = 5;
el('qz_rc_enabled').checked = true;
el('qz_rc_watch').value = '2731758714';
el('qz_rc_perDay').value = 3;
el('qz_rc_minGap').value = 5;
el('qz_rc_maxAgeHours').value = 24;
el('qz_rc_scanPosts').value = 5;
el('qz_minChars').value = 3;
el('qz_maxChars').value = 30;

await scope.saveQzone();
await new Promise((r) => setTimeout(r, 800));

// 直接看服务器上存了什么，比看页面文本可靠
const after = await (await realFetch(`${BASE}/api/qzone`)).json();
const watchers = after?.config?.watch ?? [];
const savedBox = el('qz_watch_text').value || '';
console.log('服务器名单:', JSON.stringify(watchers));
console.log('名单框回读:', JSON.stringify(savedBox));

const okWatch = watchers.length === 2
  && watchers.some((w) => Number(w.uin) === 2731758714)
  && watchers.some((w) => Number(w.uin) === 123456789);

// ---- 再测「保存日常」----
el('qz_life').value = '刚下课，包还没放下\n在便利店买关东煮';
el('qz_emo_enabled').checked = true;
el('qz_emo_chance').value = 0.35;
el('qz_emo_list').value = '😅 🙃';
el('qz_img_enabled').checked = false;
el('qz_img_chance').value = 0.5;
el('qz_img_dir').value = 'refs/qzone';
await scope.saveLife();
await new Promise((r) => setTimeout(r, 600));
const lifeAfter = await (await realFetch(`${BASE}/api/qzone/life`)).json();
const lifeList = lifeAfter?.config?.life ?? [];
console.log('服务器日常池:', lifeList.length, '条');
const okLife = lifeList.length === 2 && lifeList.includes('刚下课，包还没放下');

// ---- 再测「回复对象 = 所有人」：评论别人关掉、回复不限名单 ----
el('qz_watch_text').value = '';
el('qz_rc_enabled').checked = true;
el('qz_rc_mode').value = 'all';
el('qz_rc_watch').value = '';
await scope.saveQzone();
await new Promise((r) => setTimeout(r, 600));
const emptyCase = await (await realFetch(`${BASE}/api/qzone`)).json();
const emptyWatch = emptyCase?.config?.watch ?? [];
const emptyRc = emptyCase?.config?.replyComments ?? {};
console.log('留空保存后 → 评论名单:', JSON.stringify(emptyWatch), '回复名单:', JSON.stringify(emptyRc.watch), '每天回复上限:', emptyRc.perDay);
const okEmpty = Array.isArray(emptyWatch) && emptyWatch.length === 0
  && emptyRc.enabled === true && Array.isArray(emptyRc.watch) && emptyRc.watch.length === 0;

// ---- 还原成测试前的配置 ----
await realFetch(`${BASE}/api/qzone`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(original.config),
});
console.log('（已还原为测试前的配置）');

console.log(okWatch && okLife && okEmpty
  ? '\n✓ 面板保存正常：能加人、能保存日常、也能把名单留空'
  : `\n✗ 有失败项（名单=${okWatch} 日常=${okLife} 留空=${okEmpty}）`);
process.exit(okWatch && okLife && okEmpty ? 0 : 1);
