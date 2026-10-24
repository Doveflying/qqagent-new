import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildHealthSnapshot, HEALTH_WINDOW_MS, type HealthRuntime } from '../src/server/health.js';

const NOW = 1_800_000_000_000;

function runtime(over: Partial<HealthRuntime> = {}, onebot: Partial<NonNullable<HealthRuntime['onebot']>> = {}): HealthRuntime {
  return {
    napcatConnected: true,
    onebot: {
      connected: true, accountReady: true, apiReady: true, generation: 2, pending: 0, bufferedBytes: 0,
      implementation: { name: 'NapCat', version: '5.2.0', protocol: 'v11' }, extensions: {},
      ...onebot,
    },
    selfId: 2731758714, nickname: '宫城', uptimeMs: 3_600_000, startedAt: NOW - 3_600_000,
    ...over,
  };
}

/** 建一套空表；传 false 时故意不建表，验证「老库缺表也不炸」 */
function makeDb(withTables = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  if (!withTables) return db;
  db.exec(`
    CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, success INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, retry INTEGER NOT NULL,
      created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '');
    CREATE TABLE reply_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
      conversation_id TEXT NOT NULL, state TEXT NOT NULL, pieces TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL,
      owner_id INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', clock TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL, due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '', message_id INTEGER);
    CREATE TABLE scheduled_task_runs (task_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      status TEXT NOT NULL, message_id INTEGER, error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id, due_at));
  `);
  return db;
}

function call(db: DatabaseSync, provider: string, model: string, success: boolean, latency: number, error = '', at = NOW - 60_000) {
  db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at,error)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('chat', provider, model, Number(success), 100, 50, latency, 0, at, error);
}

function delivery(db: DatabaseSync, state: string, at = NOW - 60_000) {
  db.prepare('INSERT INTO reply_deliveries(scope,conversation_id,state,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('private:1', 'c_1', state, at, at);
}

function baseInput(db: DatabaseSync, over: Partial<Parameters<typeof buildHealthSnapshot>[0]> = {}) {
  return {
    runtime: runtime(),
    db,
    stats: { users: 1, sessions: 1, messages: 100, facts: 0, summaries: 0, emotionRecords: 0 },
    embedding: { total: 0, models: [] },
    now: NOW,
    ...over,
  };
}

test('全绿时总分接近满分，且每项检查都给出依据', () => {
  const db = makeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-health-'));
  const dbPath = path.join(dir, 'brain.db');
  fs.writeFileSync(dbPath, Buffer.alloc(1024));
  try {
    for (let i = 0; i < 40; i++) call(db, 'deepseek', 'deepseek-flash', true, 800);
    for (let i = 0; i < 5; i++) delivery(db, 'success');
    db.prepare(`INSERT INTO scheduled_tasks(id,kind,scope,owner_id,timezone,due_at,state,created_at,updated_at)
      VALUES('t1','reminder','private:1',1,'Asia/Shanghai',?, 'pending',?,?)`).run(NOW + 600_000, NOW, NOW);
    db.prepare(`INSERT INTO scheduled_task_runs(task_id,due_at,status,created_at) VALUES('t0',?, 'sent',?)`).run(NOW - 3_600_000, NOW - 3_600_000);

    const snap = buildHealthSnapshot(baseInput(db, {
      stats: { users: 3, sessions: 2, messages: 1234, facts: 10, summaries: 4, emotionRecords: 9 },
      embedding: { total: 10, models: [{ model: 'bge-m3', count: 10 }] },
      dbPath,
    }));

    assert.equal(snap.grade, 'ok', `期望健康，实际 ${snap.score} 分：${snap.summary}`);
    assert.ok(snap.score >= 95, `分数应接近满分，实际 ${snap.score}`);
    assert.equal(snap.checks.length, 6);
    assert.ok(snap.checks.every((c) => c.detail.length > 0), '每项检查都要说明依据');
    assert.ok(snap.checks.every((c) => c.status === 'ok'), '全绿场景不应有非 ok 项');
    assert.equal(snap.models.length, 1);
    assert.equal(snap.models[0]?.successRate, 1);
    assert.equal(snap.models[0]?.fail, 0);
    assert.equal(snap.trend.length, 24, '趋势固定 24 个桶');
    assert.equal(snap.trend.reduce((n, t) => n + t.ok, 0), 40);
    assert.equal(snap.failures.length, 0);
    assert.equal(snap.delivery.success, 5);
    assert.equal(snap.storage.embeddingCoverage, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('掉线 + 模型全失败 + 任务逾期时分数很低，并给出可执行建议', () => {
  const db = makeDb();
  try {
    for (let i = 0; i < 10; i++) call(db, 'deepseek', 'deepseek-flash', false, 30_000, 'HTTP 402 余额不足');
    for (let i = 0; i < 8; i++) delivery(db, 'failed');
    for (const id of ['t1', 't2']) {
      db.prepare(`INSERT INTO scheduled_tasks(id,kind,scope,owner_id,timezone,due_at,state,created_at,updated_at)
        VALUES(?,'reminder','private:1',1,'Asia/Shanghai',?, 'pending',?,?)`).run(id, NOW - 600_000, NOW, NOW);
    }
    db.prepare(`INSERT INTO scheduled_task_runs(task_id,due_at,status,error,created_at) VALUES('t1',?, 'failed','OneBot离线，尚未发送',?)`)
      .run(NOW - 600_000, NOW - 600_000);

    const snap = buildHealthSnapshot(baseInput(db, {
      runtime: runtime({ napcatConnected: false }, { connected: false, accountReady: false, apiReady: false }),
      stats: { users: 1, sessions: 1, messages: 100, facts: 10, summaries: 0, emotionRecords: 0 },
    }));

    assert.equal(snap.grade, 'error');
    assert.ok(snap.score < 40, `分数应很低，实际 ${snap.score}`);
    const byId = Object.fromEntries(snap.checks.map((c) => [c.id, c]));
    assert.equal(byId.onebot?.status, 'error');
    assert.equal(byId.llm?.status, 'error');
    assert.equal(byId.delivery?.status, 'error');
    assert.equal(byId.tasks?.status, 'error');
    assert.equal(byId.memory?.status, 'warn');
    assert.ok(byId.onebot?.hint.includes('扫码'), '掉线要指向扫码入口');
    assert.equal(snap.tasks.overdue, 2);
    assert.equal(snap.delivery.failed, 8);

    // 失败原因要能一路带到面板：模型错误原文 + 任务错误原文
    const modelFail = snap.failures.find((f) => f.kind === 'model');
    assert.ok(modelFail?.detail.includes('余额不足'), '模型失败要带原始错误');
    assert.ok(snap.failures.some((f) => f.kind === 'task' && f.detail.includes('离线')));
    assert.ok(snap.failures.some((f) => f.kind === 'delivery'));
    assert.equal(snap.models[0]?.lastError, 'HTTP 402 余额不足');
  } finally {
    db.close();
  }
});

test('空库不报错：没有调用记录时模型项标为未知而不是失败', () => {
  const db = makeDb();
  try {
    const snap = buildHealthSnapshot(baseInput(db));
    const llm = snap.checks.find((c) => c.id === 'llm');
    assert.equal(llm?.status, 'unknown');
    assert.equal(snap.models.length, 0);
    assert.equal(snap.trend.length, 24);
    assert.equal(snap.failures.length, 0);
    assert.ok(snap.score >= 80 && snap.score <= 95, `空库应偏健康但不满分，实际 ${snap.score}`);
  } finally {
    db.close();
  }
});

test('缺表的老库退化为未知，不抛异常', () => {
  const db = makeDb(false);
  try {
    const snap = buildHealthSnapshot(baseInput(db));
    assert.equal(snap.models.length, 0);
    assert.equal(snap.tasks.pending, 0);
    assert.equal(snap.failures.length, 0);
    assert.ok(snap.score > 0);
  } finally {
    db.close();
  }
});

test('窗口外的调用不计入 24 小时统计', () => {
  const db = makeDb();
  try {
    call(db, 'deepseek', 'deepseek-flash', true, 500, '', NOW - 60_000);
    call(db, 'deepseek', 'deepseek-flash', false, 500, '超时', NOW - HEALTH_WINDOW_MS - 60_000);
    const snap = buildHealthSnapshot(baseInput(db));
    assert.equal(snap.models[0]?.calls, 1);
    assert.equal(snap.models[0]?.fail, 0);
    assert.equal(snap.failures.length, 0, '24 小时之前的失败不应出现在最近失败里');
  } finally {
    db.close();
  }
});

test('接口层：/api/health/center 返回完整快照，且老库补上了 error 列', async () => {
  const { makeFixture } = await import('./helpers/chat-fixture.js');
  const { createServer } = await import('../src/server/api.js');
  const f = makeFixture({ name: 'health', expectedProvider: 'default' }, 'private:1');
  try {
    // 老库没有 error 列：attachUsageStore 应该幂等补上，并且失败原因能写进去
    f.providers.attachUsageStore(f.store.db);
    f.store.db.prepare(`INSERT INTO llm_calls(purpose,provider,model,success,prompt_tokens,completion_tokens,latency_ms,retry,created_at,error)
      VALUES('chat','default','default-model',0,0,0,1200,0,?, 'HTTP 500')`).run(Date.now() - 1000);

    const deps: any = {
      cfg: f.cfg, store: f.store, providers: f.providers, personas: (f.pipeline as any).personas,
      log: (f.pipeline as any).log,
      runtime: () => ({
        napcatConnected: true,
        onebot: { connected: true, accountReady: true, apiReady: true, generation: 1, pending: 0, bufferedBytes: 0,
          implementation: { name: 'NapCat', version: '5.2.0', protocol: 'v11' }, extensions: {} },
        selfId: 1, nickname: 'test', uptimeMs: 1000, startedAt: Date.now() - 1000,
      }),
      diagnostics: () => ({}),
      embeddingStats: () => f.store.embeddingStats(),
    };
    const { app } = createServer(deps);
    const res = await app.request('/api/health/center');
    assert.equal(res.status, 200);
    const d = await res.json() as any;
    assert.equal(d.ok, true);
    assert.equal(d.checks.length, 6);
    assert.ok(typeof d.score === 'number' && d.score >= 0 && d.score <= 100);
    assert.equal(d.models[0]?.provider, 'default');
    assert.equal(d.models[0]?.lastError, 'HTTP 500');
    assert.ok(d.failures.some((x: any) => x.kind === 'model' && x.detail.includes('HTTP 500')));
    assert.equal(d.trend.length, 24);
  } finally {
    f.store.close();
  }
});
