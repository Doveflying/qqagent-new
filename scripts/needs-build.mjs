/**
 * 判断是否需要重新构建。
 *
 * start-all.cmd 优先跑 dist\src\index.js（编译产物，启动快、不依赖 esbuild），
 * 代价是改了 src/** 却忘了 build 时，面板会「HTML 是新的、接口 404」——
 * 因为 panel.html 每次请求现读，而路由是进程启动时注册的。
 *
 * 这个脚本只比较时间戳，不做构建，由调用方决定怎么处理。
 *
 * 退出码：0 = 产物是新的；1 = src 更新，需要构建；2 = 没有 dist，需要构建
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distEntry = path.join(root, 'dist', 'src', 'index.js');

if (!fs.existsSync(distEntry)) {
  console.log('[needs-build] dist/src/index.js 不存在');
  process.exit(2);
}

const distTime = fs.statSync(distEntry).mtimeMs;
let newest = 0;
let newestFile = '';

/** 只看 .ts：panel.html 是运行时读的，改了不需要构建 */
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (entry.name.endsWith('.ts')) {
      const t = fs.statSync(p).mtimeMs;
      if (t > newest) {
        newest = t;
        newestFile = path.relative(root, p);
      }
    }
  }
}

walk(path.join(root, 'src'));

if (newest > distTime) {
  console.log(`[needs-build] ${newestFile} 比 dist 新`);
  process.exit(1);
}
process.exit(0);
