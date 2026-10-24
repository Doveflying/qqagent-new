import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LlmError } from '../src/llm/client.js';
import { classifyLlmError, LLM_ERROR_LABELS } from '../src/llm/errors.js';
import { buildCallDiagnostics, DIAG_WINDOW_MS } from '../src/server/llm-diagnostics.js';

const NOW = 1_800_000_000_000;

function makeDb(withChain = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, success INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, retry INTEGER NOT NULL,
    created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', error_kind TEXT NOT NULL DEFAULT ''${withChain ? ", chain_id TEXT NOT NULL DEFAULT ''" : ''})`);
  return db;
}

function call(db: DatabaseSync, row: {
  provider: string; model: string; success: boolean; error?: string; kind?: string;
  chain?: string; at?: number; purpose?: string; latency?: number;
}) {
  const cols = row.chain === undefined ? '' : ',chain_id';
  const marks = row.chain === undefined ? '' : ',?';
  db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at,error,error_kind${cols})
    VALUES(?,?,?,?,0,0,?,0,?,?,?${marks})`).run(
    row.purpose ?? 'chat', row.provider, row.model, Number(row.success),
    row.latency ?? 800, row.at ?? NOW - 60_000,
    row.success ? '' : row.error ?? '', row.success ? '' : row.kind ?? 'unknown',
    ...(row.chain === undefined ? [] : [row.chain]),
  );
}

test('错误分类：优先用状态码，其次用文本', () => {
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 429', 429)), 'rate_limit');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 402', 402)), 'quota');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 401', 401)), 'auth');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 404', 404)), 'model_missing');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 503', 503)), 'server_error');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 400 maximum context length', 400)), 'context_overflow');
  assert.equal(classifyLlmError(new LlmError('模型返回错误: 400 bad param', 400)), 'bad_request');
  // 状态码缺失时看文本
  assert.equal(classifyLlmError(new Error('请求超时(120000ms)')), 'timeout');
  assert.equal(classifyLlmError(new Error('请求总时间预算已耗尽')), 'timeout');
  assert.equal(classifyLlmError(new Error('fetch failed')), 'network');
  assert.equal(classifyLlmError(new Error('ECONNREFUSED 127.0.0.1:3910')), 'network');
  assert.equal(classifyLlmError(new Error('HTTP 402 余额不足')), 'quota');
  assert.equal(classifyLlmError(new Error('该候选模型不支持图片')), 'unsupported');
  assert.equal(classifyLlmError(new Error('完全看不懂的报错')), 'unknown');
  // 主动取消优先，且不能被算成超时
  assert.equal(classifyLlmError(new LlmError('请求已取消', undefined, false, true)), 'cancelled');
  assert.equal(classifyLlmError(new LlmError('请求超时(30000ms)', undefined, false, true)), 'cancelled');
  assert.equal(LLM_ERROR_LABELS.rate_limit, '限流');
});

test('降级链路：主模型 429 后切备用成功要能还原全过程', () => {
  const db = makeDb();
  try {
    call(db, { provider: 'deepseek', model: 'deepseek-pro', success: false, kind: 'rate_limit', error: 'HTTP 429 限流', chain: 'c1', at: NOW - 30_000, latency: 900 });
    call(db, { provider: 'deepseek', model: 'deepseek-pro', success: false, kind: 'rate_limit', error: 'HTTP 429 限流', chain: 'c1', at: NOW - 28_000, latency: 1100 });
    call(db, { provider: 'zhipu', model: 'glm-flash', success: true, chain: 'c1', at: NOW - 26_000, latency: 700 });
    // 同模型重试后成功：不算降级
    call(db, { provider: 'deepseek', model: 'deepseek-flash', success: false, kind: 'timeout', error: '请求超时', chain: 'c2', at: NOW - 20_000 });
    call(db, { provider: 'deepseek', model: 'deepseek-flash', success: true, chain: 'c2', at: NOW - 19_000 });
    // 全失败：没有「降级到哪」，不列出
    call(db, { provider: 'deepseek', model: 'deepseek-pro', success: false, kind: 'quota', error: '余额不足', chain: 'c3', at: NOW - 10_000 });

    const d = buildCallDiagnostics(db, NOW);
    assert.equal(d.degradations.length, 1);
    const g = d.degradations[0]!;
    assert.equal(g.from, 'deepseek/deepseek-pro');
    assert.equal(g.to, 'zhipu/glm-flash');
    assert.equal(g.reasonKind, 'rate_limit');
    assert.equal(g.reasonLabel, '限流');
    assert.equal(g.attempts, 2, '切换前失败了两次');
    assert.equal(g.elapsedMs, 4000);
    assert.equal(g.steps.length, 3);
    assert.deepEqual(g.steps.map((s) => s.ok), [false, false, true]);

    assert.equal(d.totals.calls, 6);
    assert.equal(d.totals.failed, 4);
    assert.equal(d.totals.degraded, 1);
  } finally {
    db.close();
  }
});

test('失败原因按类别聚合并算占比，取消不计入失败', () => {
  const db = makeDb();
  try {
    for (let i = 0; i < 6; i++) call(db, { provider: 'a', model: 'm', success: false, kind: 'rate_limit', error: '429', chain: `r${i}` });
    for (let i = 0; i < 3; i++) call(db, { provider: 'a', model: 'm', success: false, kind: 'timeout', error: '超时', chain: `t${i}` });
    call(db, { provider: 'a', model: 'm', success: false, kind: 'quota', error: '余额', chain: 'q' });
    for (let i = 0; i < 4; i++) call(db, { provider: 'a', model: 'm', success: false, kind: 'cancelled', error: '请求已取消', chain: `c${i}` });
    call(db, { provider: 'a', model: 'm', success: true, chain: 'ok' });

    const d = buildCallDiagnostics(db, NOW);
    assert.equal(d.totals.calls, 15);
    assert.equal(d.totals.failed, 10, '4 次主动取消不该算失败');
    const kinds = Object.fromEntries(d.errorKinds.map((k) => [k.kind, k]));
    assert.equal(kinds.rate_limit?.count, 6);
    assert.equal(kinds.rate_limit?.share, 0.6);
    assert.equal(kinds.cancelled, undefined, '取消不进入失败分布');
    assert.equal(kinds.timeout?.label, '超时');
    // 6/10 + 3/10 + 1/10 正好 100%
    assert.equal(d.errorKinds.reduce((n, k) => n + k.count, 0), 10);
  } finally {
    db.close();
  }
});

test('空库与缺列老库都不抛错', () => {
  const empty = makeDb();
  try {
    const d = buildCallDiagnostics(empty, NOW);
    assert.equal(d.totals.calls, 0);
    assert.equal(d.errorKinds.length, 0);
    assert.equal(d.degradations.length, 0);
  } finally {
    empty.close();
  }

  const legacy = makeDb(false); // 没有 chain_id
  try {
    call(legacy, { provider: 'a', model: 'm', success: false, kind: 'timeout', error: '超时' });
    const d = buildCallDiagnostics(legacy, NOW);
    assert.equal(d.degradations.length, 0, '没有 chain_id 时无法还原链路，但统计照常');
    assert.equal(d.totals.failed, 1);
    assert.equal(d.errorKinds[0]?.kind, 'timeout');
  } finally {
    legacy.close();
  }
});

test('窗口外与未来数据不混进来', () => {
  const db = makeDb();
  try {
    call(db, { provider: 'a', model: 'm', success: false, kind: 'timeout', error: '超时', chain: 'old', at: NOW - DIAG_WINDOW_MS - 1000 });
    call(db, { provider: 'a', model: 'm', success: false, kind: 'rate_limit', error: '429', chain: 'new', at: NOW - 1000 });
    const d = buildCallDiagnostics(db, NOW);
    assert.equal(d.totals.calls, 1);
    assert.equal(d.errorKinds.length, 1);
    assert.equal(d.errorKinds[0]?.kind, 'rate_limit');
  } finally {
    db.close();
  }
});

test('接口层：/api/llm/diagnostics 返回分布与降级链路', async () => {
  const { makeFixture } = await import('./helpers/chat-fixture.js');
  const { createServer } = await import('../src/server/api.js');
  const f = makeFixture({ name: 'diag', expectedProvider: 'default' }, 'private:1');
  try {
    f.providers.attachUsageStore(f.store.db);
    const ins = f.store.db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at,error,error_kind,chain_id)
      VALUES('chat',?,?,?,0,0,?,0,?,?,?,?)`);
    const now = Date.now();
    ins.run('default', 'default-model', 0, 900, now - 3000, 'HTTP 429 rate limit', 'rate_limit', 'chain-x');
    ins.run('backup', 'backup-model', 1, 700, now - 2000, '', '', 'chain-x');

    const deps: any = {
      cfg: f.cfg, store: f.store, providers: f.providers, personas: (f.pipeline as any).personas,
      log: (f.pipeline as any).log,
      runtime: () => ({ napcatConnected: true, selfId: 1, nickname: 't', uptimeMs: 1, startedAt: now }),
      diagnostics: () => ({}),
      embeddingStats: () => f.store.embeddingStats(),
    };
    const { app } = createServer(deps);
    const res = await app.request('/api/llm/diagnostics');
    assert.equal(res.status, 200);
    const d = await res.json() as any;
    assert.equal(d.totals.degraded, 1);
    assert.equal(d.errorKinds[0]?.kind, 'rate_limit');
    assert.equal(d.degradations[0]?.from, 'default/default-model');
    assert.equal(d.degradations[0]?.to, 'backup/backup-model');
  } finally {
    f.store.close();
  }
});
