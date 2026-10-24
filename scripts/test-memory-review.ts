import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers/chat-fixture.js';
import { MemoryRetriever } from '../src/memory/retriever.js';
import { createServer } from '../src/server/api.js';

function fixture() {
  return makeFixture({ name: 'review', expectedProvider: 'default' }, 'private:1');
}

test('待确认的事实不进检索，确认后才生效', () => {
  const f = fixture();
  try {
    const id = f.store.addFact({ userId: 1, scope: 'private:1', factType: 'preference', content: '用户喜欢喝无糖可乐', reviewState: 'pending' });
    assert.equal(f.store.searchFacts(1, '可乐', { scope: 'private:1' }).length, 0, '待确认不应被关键词检索到');
    assert.equal(f.store.getFactsByUser(1, { scope: 'private:1' }).length, 0, '待确认不应进用户档案');
    assert.equal(f.store.listPendingFacts({ userId: 1 }).length, 1);

    const confirmed = f.store.setFactReviewState(id, 'confirmed');
    assert.equal(confirmed?.review_state, 'confirmed');
    assert.equal(f.store.searchFacts(1, '可乐', { scope: 'private:1' }).length, 1, '确认后应能被检索');
    assert.equal(f.store.getFactsByUser(1, { scope: 'private:1' }).length, 1);
    assert.equal(f.store.listPendingFacts({ userId: 1 }).length, 0, '确认后离开待确认区');
  } finally {
    f.store.close();
  }
});

test('驳回的事实留痕但永不召回', () => {
  const f = fixture();
  try {
    const id = f.store.addFact({ userId: 1, scope: 'private:1', factType: 'other', content: '用户说他其实住在火星', reviewState: 'pending' });
    f.store.setFactReviewState(id, 'rejected');
    assert.equal(f.store.searchFacts(1, '火星', { scope: 'private:1' }).length, 0);
    assert.equal(f.store.getFactsByUser(1, { scope: 'private:1' }).length, 0);
    assert.equal(f.store.listPendingFacts({ userId: 1 }).length, 0, '驳回后不该再出现在待确认区');
    // 记录还在，只是状态变了（留痕，避免同一条被反复抽出来）
    const row = f.store.db.prepare('SELECT review_state, active FROM memory_facts WHERE id=?').get(id) as { review_state: string; active: number };
    assert.equal(row.review_state, 'rejected');
    assert.equal(row.active, 1);
  } finally {
    f.store.close();
  }
});

test('默认写入的事实是 confirmed，行为与升级前一致', () => {
  const f = fixture();
  try {
    f.store.addFact({ userId: 1, scope: 'private:1', factType: 'identity', content: '用户是工程师' });
    assert.equal(f.store.listPendingFacts({ userId: 1 }).length, 0);
    assert.equal(f.store.searchFacts(1, '工程师', { scope: 'private:1' }).length, 1);
  } finally {
    f.store.close();
  }
});

test('召回记录能还原每条记忆的命中来源', () => {
  const f = fixture();
  try {
    const id = f.store.addFact({ userId: 1, scope: 'private:1', factType: 'preference', content: '用户喜欢喝无糖可乐' });
    const recallId = f.store.logRecall({
      scope: 'private:1',
      conversationId: 'c1',
      userId: 1,
      turnId: 'turn-1',
      query: '可乐',
      items: [{ id, content: '用户喜欢喝无糖可乐', source: 'keyword', score: 0.87, scope: 'private:1', factType: 'preference', confidence: 0.9 }],
      summaries: ['之前聊过饮料'],
      stats: { mode: 'keyword', localFacts: 1, sharedFacts: 0, semanticHits: 0 },
    });
    assert.ok(recallId > 0);

    const rows = f.store.listRecalls({ scope: 'private:1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.turnId, 'turn-1');
    assert.equal(rows[0]?.query, '可乐');
    assert.equal(rows[0]?.items[0]?.source, 'keyword');
    assert.equal(rows[0]?.items[0]?.content, '用户喜欢喝无糖可乐');
    assert.deepEqual(rows[0]?.summaries, ['之前聊过饮料']);
    assert.equal((rows[0]?.stats as { mode: string }).mode, 'keyword');

    assert.equal(f.store.listRecalls({ scope: 'group:2' }).length, 0, '按会话过滤');
  } finally {
    f.store.close();
  }
});

test('检索结果里的 items 与真正塞进 prompt 的 facts 同源同序', () => {
  const f = fixture();
  try {
    f.store.addFact({ userId: 1, scope: 'private:1', factType: 'preference', content: '用户喜欢喝无糖可乐' });
    f.store.addFact({ userId: 1, scope: 'private:1', factType: 'preference', content: '用户喜欢喝拿铁' });
    const retriever = new MemoryRetriever(f.store, f.cfg.memory, (f.pipeline as any).log);

    const hit = retriever.retrieve('private:1', 1, '可乐');
    assert.deepEqual(hit.items.map((i) => i.content), hit.facts);
    assert.equal(hit.items[0]?.source, 'keyword');
    assert.equal(hit.stats.mode, 'keyword');

    // 没有查询词时走兜底，来源要标成 fallback
    const fallback = retriever.retrieve('private:1', 1, '');
    assert.equal(fallback.stats.mode, 'fallback');
    assert.ok(fallback.items.length > 0);
    assert.ok(fallback.items.every((i) => i.source === 'fallback'));
    assert.deepEqual(fallback.items.map((i) => i.content), fallback.facts);
  } finally {
    f.store.close();
  }
});

test('接口层：待确认列表、确认/驳回、召回记录', async () => {
  const f = fixture();
  try {
    const id = f.store.addFact({ userId: 1, scope: 'private:1', factType: 'preference', content: '用户喜欢喝无糖可乐', reviewState: 'pending' });
    f.store.logRecall({ scope: 'private:1', userId: 1, query: '可乐', items: [], summaries: [], stats: { mode: 'keyword' } });

    const deps: any = {
      cfg: f.cfg, store: f.store, providers: f.providers, personas: (f.pipeline as any).personas,
      log: (f.pipeline as any).log,
      runtime: () => ({ napcatConnected: false, selfId: 0, nickname: '', uptimeMs: 1, startedAt: 1 }),
      diagnostics: () => ({}),
      embeddingStats: () => f.store.embeddingStats(),
    };
    const { app } = createServer(deps);

    let res = await app.request('/api/memory/pending');
    assert.equal(res.status, 200);
    let body = await res.json() as any;
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].id, id);

    // 非法 state 要被拒
    res = await app.request('/api/memory/facts/' + id + '/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'whatever' }),
    });
    assert.equal(res.status, 400);

    res = await app.request('/api/memory/facts/' + id + '/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'confirmed' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).fact.reviewState, 'confirmed');

    res = await app.request('/api/memory/pending');
    assert.equal((await res.json() as any).records.length, 0);

    res = await app.request('/api/memory/recalls?scope=private:1');
    assert.equal(res.status, 200);
    body = await res.json() as any;
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].scope, 'private:1');

    // 不存在的事实返回 404
    res = await app.request('/api/memory/facts/99999/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'confirmed' }),
    });
    assert.equal(res.status, 404);
  } finally {
    f.store.close();
  }
});
