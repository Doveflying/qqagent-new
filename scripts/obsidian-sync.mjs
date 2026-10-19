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
  // 去掉「## 相关」之后的双链区，那是给人看的导航，不该进提示词
  t = t.split(/\r?\n##\s*相关/)[0];
  const lines = t.split(/\r?\n/)
    .filter((line) => !/^>\s*由 agent 更新于/.test(line.trim()))
    .map((line) => line.trim())
    // 标题行去掉：列表符号和 # 会诱导模型输出"列点式"回答
    .filter(Boolean)
    // 一级标题是笔记名，不进提示词
    .filter((line) => !/^#\s+/.test(line))
    // 其余标题转成「标签：」保留分类语义，但不带 Markdown 语法
    .map((line) => line.replace(/^#{2,6}\s+(.+)$/, (_, h) => h + '：'))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => !/^\[\[.*\]\]$/.test(line));
  return lines.join('\n').trim();
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

/** 解析「Q: / A:」格式的示例对话。 */
function parseExamples(md) {
  const out = [];
  let cur = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const q = /^Q[:：]\s*(.+)$/.exec(line);
    const a = /^A[:：]\s*(.+)$/.exec(line);
    if (q) {
      if (cur && cur.assistant) out.push(cur);
      cur = { user: q[1].trim(), assistant: '' };
    } else if (a) {
      if (cur) cur.assistant = a[1].trim();
    } else if (line && cur && cur.assistant) {
      cur.assistant += `\n${line}`;
    }
  }
  if (cur && cur.assistant) out.push(cur);
  return out.slice(0, 24);
}
/**
 * 让人格改动立刻生效：调用本地面板的 /api/personas/reload。
 * 面板没开就跳过（下次启动会读新的 YAML），不算失败。
 */
async function reloadPersonas() {
  const url = process.env.QQAGENT_PANEL || 'http://127.0.0.1:3081';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(`${url}/api/personas/reload`, { method: 'POST', signal: ctl.signal });
    clearTimeout(timer);
    const text = (await res.text()).slice(0, 120);
    if (res.ok) log(`已通知面板重载人格（HTTP ${res.status}）`);
    else log(`重载人格失败（HTTP ${res.status}）：${text}，下次启动生效`);
  } catch {
    log('面板未运行，人格改动将在下次启动时生效');
  }
}

// ---------------- import：笔记 -> 人格 ----------------
async function doImport(cfg) {
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
    // 字段 = 主笔记正文 + 后面追加的 extra 段落，所以只要以主笔记开头就算没变
    if (before === body || before.startsWith(body)) { log(`${field}：无变化`); continue; }
    changes.push({ field, rel, chars: body.length });
    persona.structured[field] = `${body}\n`;
  }

  // 附加段落：日常 → identity，雷点 → interactionStyle
  for (const extra of cfg.import?.extra ?? []) {
    if (!extra?.into || !extra?.note) continue;
    const body = readNote(cfg, extra.note);
    if (!body) continue;
    const base = String(persona.structured[extra.into] || '').trimEnd();
    if (base.includes(body.slice(0, 40))) { log(`${extra.into} 已包含 ${extra.note}，跳过`); continue; }
    persona.structured[extra.into] = `${base}\n\n${body}\n`;
    changes.push({ field: `${extra.into}+=${extra.note}`, rel: extra.note, chars: body.length });
  }

  // 示例对话 → persona.examples（比规则更能稳定语气）
  if (cfg.import?.examples) {
    const body = readNote(cfg, cfg.import.examples);
    const pairs = parseExamples(body);
    if (pairs.length > 0) {
      const before = JSON.stringify(persona.examples ?? []);
      if (before !== JSON.stringify(pairs)) {
        persona.examples = pairs;
        changes.push({ field: `examples(${pairs.length})`, rel: cfg.import.examples, chars: pairs.length });
      } else {
        log('examples：无变化');
      }
    }
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
  await reloadPersonas();
}

/**
 * 一条事实在笔记里的展示行。导出和追加共用，保证去重时能按 content 命中。
 */
function formatFact(r) {
  const t = new Date(Number(r.created_at)).toLocaleDateString('zh-CN');
  const scope = r.private ? '私密' : '共享';
  const conf = typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '?';
  return `- ${t} · [${scope}] ${r.content}  \`置信 ${conf}\``;
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
      for (const r of rows) lines.push(formatFact(r));
    }
    lines.push('', '## 相关', '', '- [[记忆索引]] · [[设定]]', '');
    const body = lines.join('\n');

    if (DRY) {
      log(`[dry] 将写入 ${cfg.export.dir}/${title}.md（${rows.length} 条事实）`);
      return;
    }

    const target = `${cfg.export.dir}/${title}.md`;
    const vaultPath = path.join(cfg.vault, target.replace(/\//g, path.sep));

    // 当天的笔记已经存在：只追加还没进过笔记的事实，绝不覆盖（CLI 也会拒绝改写）
    if (fs.existsSync(vaultPath)) {
      const prev = fs.readFileSync(vaultPath, 'utf8');
      const fresh = rows.filter((r) => !prev.includes(r.content));
      if (fresh.length === 0) {
        log(`${target} 已是最新，无新事实`);
        return;
      }
      const added = [
        '',
        `## ${now.toLocaleString('zh-CN')} 追加`,
        '',
        ...fresh.map(formatFact),
        '',
      ].join('\n');
      const cliOut = runCli(cfg, ['append', target, '--body', added]);
      log(`已追加 ${fresh.length} 条到 ${target}：${cliOut.split('\n')[0]}`);
      return;
    }

    const tmp = path.join(os.tmpdir(), `qqagent-facts-${Date.now()}.md`);
    fs.writeFileSync(tmp, body, 'utf8');
    try {
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
  if (DO_IMPORT) await doImport(cfg);
  if (DO_EXPORT) await doExport(cfg);
}

main().catch((e) => fail(e?.message ?? String(e)));
