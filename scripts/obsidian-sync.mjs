// Obsidian 角色记忆库 <-> QQ Agent
//
//   --import   把 Obsidian 的「设定 / 口癖 / 关系」写进人格的结构化字段
//              （Obsidian 是源头，人格 YAML 是产物）
//   --export   把 brain.db 里的长期事实导出成角色库里的笔记
//   --dry      只打印将要发生的事，不写任何文件
//
// 写 vault 一律通过 obsidian-bridge CLI（自动备份 + 哈希校验 + 操作日志），
// 不直接改 vault 里的 md 文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CFG_PATH = path.join(REPO, 'config', 'obsidian.json');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const DO_IMPORT = args.has('--import');
const DO_EXPORT = args.has('--export');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function log(msg) { console.log(`[obsidian] ${msg}`); }
function fail(msg) { console.error(`[obsidian] ${msg}`); process.exit(1); }

/** 去掉 frontmatter 与 agent 署名行，得到正文。 */
function stripFrontmatter(text) {
  let t = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
  if (m) t = t.slice(m[0].length);
  return t
    .split(/\r?\n/)
    .filter((line) => !/^>\s*由 agent 更新于/.test(line.trim()))
    .join('\n')
    .trim();
}

function readNote(cfg, relPath) {
  const full = path.join(cfg.vault, relPath.replace(/\//g, path.sep));
  if (!fs.existsSync(full)) throw new Error(`笔记不存在：${full}`);
  return stripFrontmatter(fs.readFileSync(full, 'utf8'));
}

/** 通过 CLI 写 vault：new / set / append。 */
function runCli(cfg, cliArgs) {
  const cli = cfg.cli;
  if (!fs.existsSync(cli)) throw new Error(`找不到 obsidian-bridge CLI：${cli}`);
  const r = spawnSync(process.execPath, [cli, ...cliArgs, '--vault', cfg.vault], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`CLI 失败（${r.status}）：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  return (r.stdout || '').trim();
}

// ---------------- import：笔记 -> 人格 ----------------
function doImport(cfg) {
  const personaPath = path.join(REPO, 'config', 'personas', `${cfg.persona}.yaml`);
  if (!fs.existsSync(personaPath)) fail(`找不到人格文件：${personaPath}`);
  const persona = parseYaml(fs.readFileSync(personaPath, 'utf8')) || {};
  persona.structured = persona.structured || {};

  const mapping = [
    ['identity', cfg.import?.identity],
    ['speakingStyle', cfg.import?.speakingStyle],
    ['interactionStyle', cfg.import?.interactionStyle],
  ];

  const changes = [];
  for (const [field, rel] of mapping) {
    if (!rel) continue;
    const body = readNote(cfg, rel);
    if (!body) { log(`跳过 ${field}：${rel} 内容为空`); continue; }
    const before = String(persona.structured[field] || '').trim();
    if (before === body) { log(`${field}：无变化`); continue; }
    changes.push({ field, rel, chars: body.length });
    persona.structured[field] = `${body}\n`;
  }

  if (changes.length === 0) { log('人格已与笔记一致，无需写入'); return; }

  if (DRY) {
    for (const c of changes) log(`[dry] 将更新 ${c.field} ← ${c.rel}（${c.chars} 字）`);
    return;
  }

  // 清理掉旧注释头，写成纯数据文件（此后由 Obsidian 驱动）
  const header = `# 由 Obsidian 角色库同步生成：${cfg.vault}\n# 修改请改 Obsidian 笔记，然后运行 scripts/obsidian-sync.mjs --import\n`;
  fs.writeFileSync(personaPath, header + stringifyYaml(persona), 'utf8');
  for (const c of changes) log(`已写入 ${c.field} ← ${c.rel}（${c.chars} 字）`);
  log('人格文件已更新，重启 Agent 或面板「人格 → 重新加载」后生效');
}

// ---------------- export：事实 -> 笔记 ----------------
function doExport(cfg) {
  const dbPath = path.join(REPO, cfg.export?.db || 'data/brain.db');
  if (!fs.existsSync(dbPath)) fail(`找不到数据库：${dbPath}`);

  let rows = [];


  const run = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db.prepare(
        'SELECT id, user_id, scope, fact_type, content, confidence, private, created_at FROM memory_facts WHERE active=1 ORDER BY id DESC LIMIT 500',
      ).all();
    } finally {
      db.close();
    }

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const title = `事实-${stamp}`;
    const lines = [
      '---',
      `title: ${title}`,
      'tags: [记忆, 事实]',
      '---',
      '',
      `# ${title}`,
      '',
      `导出时间：${now.toLocaleString('zh-CN')}，共 ${rows.length} 条。`,
      '',
      '> 本文件由 QQ Agent 自动生成，手动修改会被下次导出覆盖。',
      '',
    ];

    if (rows.length === 0) {
      lines.push('（当前没有长期事实。多聊几句后，agent 会自己抽取。）');
    } else {
      for (const r of rows) {
        const t = new Date(Number(r.created_at)).toLocaleDateString('zh-CN');
        const scope = r.private ? '私密' : '共享';
        const conf = typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '?';
        lines.push(`- ${t} · [${scope}] ${r.content}  \`置信 ${conf}\``);
      }
    }
    lines.push('', '## 相关', '', '- [[记忆索引]] · [[设定]]', '');
    const body = lines.join('\n');

    if (DRY) {
      log(`[dry] 将写入 ${cfg.export.dir}/${title}.md（${rows.length} 条事实）`);
      return;
    }

    const tmp = path.join(os.tmpdir(), `qqagent-facts-${Date.now()}.md`);
    fs.writeFileSync(tmp, body, 'utf8');
    try {
      const target = `${cfg.export.dir}/${title}.md`;
      const cliOut = runCli(cfg, ['new', target, '--body-file', tmp]);
      log(`已创建 ${target}：${cliOut.split('\n')[0]}`);
      if (cfg.export.index) {
        const idx = runCli(cfg, ['append', cfg.export.index, '--body', `\n- [[${title}]]`]);
        log(`已更新索引：${idx.split('\n')[0]}`);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  return run();
}

async function main() {
  const cfg = readJson(CFG_PATH);
  if (!cfg) fail(`读不到配置 ${CFG_PATH}`);
  if (!cfg.vault || !fs.existsSync(cfg.vault)) fail(`vault 不存在：${cfg.vault}`);

  if (!DO_IMPORT && !DO_EXPORT) {
    log('用法：--import（笔记→人格） / --export（事实→笔记） / --dry（只看不改）');
    return;
  }
  if (DO_IMPORT) doImport(cfg);
  if (DO_EXPORT) await doExport(cfg);
}

main().catch((e) => fail(e?.message ?? String(e)));
