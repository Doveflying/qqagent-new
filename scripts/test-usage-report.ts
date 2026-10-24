import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildUsageReport, costOf, loadUsageConfig, priceFor, type UsageConfig } from '../src/server/usage-report.js';

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 本地时间 2026-10-24 12:00

const CFG: UsageConfig = {
  currency: 'CNY',
  unit: 1_000_000,
  pricing: {
    'a/cheap': { input: 1, output: 2 },
    'expensive-model': { input: 10, output: 20 },
    '*': { input: 5, output: 5 },
  },
  budget: { daily: 10, monthly: 100, alertRatio: 0.8 },
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, success INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, retry INTEGER NOT NULL,
    created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', error_kind TEXT NOT NULL DEFAULT '',
    chain_id TEXT NOT NULL DEFAULT '')`);
  return db;
}

function call(db: DatabaseSync, row: { provider: string; model: string; prompt: number; completion: number; at: number; purpose?: string }) {
  db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at)
    VALUES(?,?,?,1,?,?,1,0,?)`).run(row.purpose ?? 'chat', row.provider, row.model, row.prompt, row.completion, row.at);
}

test('单价查找：provider/model → model → * → 没有', () => {
  assert.deepEqual(priceFor(CFG, 'a', 'cheap'), { price: { input: 1, output: 2 }, exact: true });
  assert.deepEqual(priceFor(CFG, 'whatever', 'expensive-model'), { price: { input: 10, output: 20 }, exact: true });
  const fallback = priceFor(CFG, 'x', 'unknown-model');
  assert.deepEqual(fallback.price, { input: 5, output: 5 });
  assert.equal(fallback.exact, false, '兜底单价要标记成非精确');

  const noFallback: UsageConfig = { ...CFG, pricing: { 'a/cheap': { input: 1, output: 2 } } };
  assert.equal(priceFor(noFallback, 'x', 'y').price, undefined);
});

test('花费计算：按百万 token 计价', () => {
  // 1M 输入 + 1M 输出 → 1 + 2 = 3
  assert.equal(costOf(CFG, 'a', 'cheap', 1_000_000, 1_000_000).cost, 3);
  // 10 万输入 + 5 万输出 → 0.1*1 + 0.05*2 = 0.2
  assert.ok(Math.abs(costOf(CFG, 'a', 'cheap', 100_000, 50_000).cost - 0.2) < 1e-9);
  // 未定价且没有兜底 → 不计费，但标记为 priced:false
  const none = costOf({ ...CFG, pricing: {} }, 'x', 'y', 1000, 1000);
  assert.equal(none.cost, 0);
  assert.equal(none.priced, false);
});

test('今日与本月分开统计，不同模型套不同单价', () => {
  const db = makeDb();
  try {
    const todayStart = new Date(2026, 9, 24, 0, 0, 0).getTime();
    const yesterday = todayStart - 3600_000;
    const lastMonth = new Date(2026, 8, 20, 10, 0, 0).getTime();
    // 今天：a/cheap 1M+1M = 3 元；expensive-model 0.5M+0.5M = 5+10 = 15 元
    call(db, { provider: 'a', model: 'cheap', prompt: 1_000_000, completion: 1_000_000, at: NOW });
    call(db, { provider: 'p', model: 'expensive-model', prompt: 500_000, completion: 500_000, at: NOW });
    // 昨天：1 元
    call(db, { provider: 'a', model: 'cheap', prompt: 1_000_000, completion: 0, at: yesterday });
    // 上个月：不进本月
    call(db, { provider: 'a', model: 'cheap', prompt: 1_000_000, completion: 0, at: lastMonth });

    const r = buildUsageReport(db, NOW, CFG);
    assert.equal(r.today.calls, 2);
    assert.ok(Math.abs(r.today.cost - 18) < 1e-6, `今日应为 18，实际 ${r.today.cost}`);
    assert.equal(r.today.tokens, 3_000_000);
    assert.equal(r.month.calls, 3, '本月含昨天不含上月');
    assert.ok(Math.abs(r.month.cost - 19) < 1e-6, `本月应为 19，实际 ${r.month.cost}`);

    // 按模型排序：贵的在前
    assert.equal(r.byModel[0]?.model, 'expensive-model');
    assert.ok(Math.abs((r.byModel[0]?.cost ?? 0) - 15) < 1e-6);
    // 环节维度
    assert.equal(r.byPurpose[0]?.purpose, 'chat');
    // 14 天趋势：今天必须是最高的那根
    assert.equal(r.days.length, 14);
    const last = r.days[r.days.length - 1]!;
    assert.equal(last.calls, 2);
  } finally {
    db.close();
  }
});

test('预算等级：充足 / 接近 / 超支 / 未设置', () => {
  const db = makeDb();
  try {
    const cheap: UsageConfig = { ...CFG, budget: { daily: 100, monthly: 1000, alertRatio: 0.8 } };
    call(db, { provider: 'a', model: 'cheap', prompt: 1_000_000, completion: 0, at: NOW });
    assert.equal(buildUsageReport(db, NOW, cheap).budget.level, 'ok');

    const near: UsageConfig = { ...CFG, budget: { daily: 1.2, monthly: 1000, alertRatio: 0.8 } };
    assert.equal(buildUsageReport(db, NOW, near).budget.level, 'warn', '1/1.2 = 83% ≥ 80%');

    const over: UsageConfig = { ...CFG, budget: { daily: 0.5, monthly: 1000, alertRatio: 0.8 } };
    const r = buildUsageReport(db, NOW, over);
    assert.equal(r.budget.level, 'over');
    assert.match(r.budget.message, /已超预算/);

    const unset: UsageConfig = { ...CFG, budget: { daily: 0, monthly: 0, alertRatio: 0.8 } };
    assert.equal(buildUsageReport(db, NOW, unset).budget.level, 'unset');
  } finally {
    db.close();
  }
});

test('突增检测：今天远超近 7 天日均才报警', () => {
  const db = makeDb();
  try {
    // 前 7 天每天 0.5 元
    for (let i = 1; i <= 7; i++) {
      call(db, { provider: 'a', model: 'cheap', prompt: 500_000, completion: 0, at: NOW - i * 86400000 });
    }
    const base = buildUsageReport(db, NOW, CFG);
    assert.equal(base.spike.level, 'ok', '今天还没花钱，不该报');

    // 今天花 5 元 = 日均的 10 倍
    call(db, { provider: 'a', model: 'cheap', prompt: 5_000_000, completion: 0, at: NOW });
    const spiked = buildUsageReport(db, NOW, CFG);
    assert.equal(spiked.spike.level, 'warn');
    assert.ok(spiked.spike.ratio > 2.5);
    assert.match(spiked.spike.message, /倍/);
  } finally {
    db.close();
  }
});

test('未定价的模型只统计 token，不计入金额但会被标记', () => {
  const db = makeDb();
  try {
    const noFallback: UsageConfig = { ...CFG, pricing: {} };
    call(db, { provider: 'x', model: 'y', prompt: 1000, completion: 1000, at: NOW });
    const r = buildUsageReport(db, NOW, noFallback);
    assert.equal(r.today.cost, 0);
    assert.equal(r.today.calls, 1);
    assert.equal(r.today.unpricedCalls, 1);
    assert.equal(r.today.tokens, 2000);
  } finally {
    db.close();
  }
});

test('配置文件坏掉时退回内置默认值，不抛错', () => {
  const cfg = loadUsageConfig('D:/develop/tmp/definitely-missing-usage.json');
  assert.equal(cfg.currency, 'CNY');
  assert.ok(cfg.pricing['*'], '内置默认要有兜底单价');
  assert.ok(cfg.budget.daily >= 0);
});

test('接口层：/api/usage 返回预算、模型与环节分布', async () => {
  const { makeFixture } = await import('./helpers/chat-fixture.js');
  const { createServer } = await import('../src/server/api.js');
  const f = makeFixture({ name: 'usage-api', expectedProvider: 'default' }, 'private:1');
  try {
    const now = Date.now();
    f.providers.attachUsageStore(f.store.db);
    f.store.db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at,error,error_kind,chain_id)
      VALUES(?,?,?,1,?,?,1,0,?,'','','')`).run('chat', 'a', 'cheap', 1_000_000, 1_000_000, now);

    const deps: any = {
      cfg: f.cfg, store: f.store, providers: f.providers, personas: (f.pipeline as any).personas,
      log: (f.pipeline as any).log,
      runtime: () => ({ napcatConnected: false, selfId: 0, nickname: '', uptimeMs: 1, startedAt: 1 }),
      diagnostics: () => ({}),
      embeddingStats: () => f.store.embeddingStats(),
    };
    const { app } = createServer(deps);
    const res = await app.request('/api/usage');
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.ok(body.today.calls >= 1);
    assert.ok(body.today.cost > 0, '有兜底单价就应该算出金额');
    assert.ok(Array.isArray(body.byModel));
    assert.ok(Array.isArray(body.byPurpose));
    assert.equal(body.days.length, 14);
    assert.ok(['ok', 'warn', 'over', 'unset'].includes(body.budget.level));
  } finally {
    f.store.close();
  }
});
