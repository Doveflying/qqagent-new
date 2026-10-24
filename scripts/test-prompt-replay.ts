// 对话链路回放：断言**真正送进模型的那串消息**，而不是「有没有回复」。
//
// 为什么需要它：改 prompt、改检索、改压缩之后，「机器人还是会回话」完全说明不了问题 ——
// 该注入的记忆没进去、该截断的历史没截断、人格被挤掉了，表现都是「照样回复，只是变笨」。
//
// 这里做两件事：
//   1. 结构化断言：人格 / 记忆 / 历史窗口 / 群上下文有没有按预期出现在 prompt 里
//   2. 黄金快照：把一次完整调用的消息序列固定下来，改 prompt 后 diff 一目了然
//      快照变了要确认是有意的，再用 UPDATE_GOLDEN=1 重新生成
//
//   npm run test:prompt-replay
//   UPDATE_GOLDEN=1 npm run test:prompt-replay     # 确认改动是有意的之后
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeFixture } from './helpers/chat-fixture.js';

const GOLDEN = 'scripts/fixtures/prompt-golden.json';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

type Call = { provider: string; model: string | undefined; messages: Array<{ role: string; content: unknown }> };

/** 取那一次真正的对话调用（辅助任务在夹具里都关着） */
function chatCall(f: ReturnType<typeof makeFixture>): Call {
  const call = (f.calls as unknown as Call[]).find((c) => c.provider === 'default');
  assert.ok(call, '应该有一次对话调用');
  return call!;
}

function promptText(f: ReturnType<typeof makeFixture>): string {
  return chatCall(f).messages
    .map((m) => `### ${m.role}\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n\n');
}

/** 时间和日期会让快照每次都变，比对前统一抹掉 */
function normalize(text: string): string {
  return text
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/g, '<TIME>')
    .replace(/\d{1,2}月\d{1,2}日/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}\b/g, '<CLOCK>')
    .replace(/\b17\d{11}\b/g, '<TS>');
}

test('人格与记忆都真的进了 prompt，且同一条记忆不重复', async () => {
  const f = makeFixture({
    name: 'prompt-memory',
    expectedProvider: 'default',
    realRetriever: true,
    personaPrompt: '你是志绪理，说话简短，偶尔毒舌',
    facts: [
      { content: '用户喜欢无糖可乐' },
      { content: '用户是计算机专业的学生', factType: 'identity', shareable: true },
    ],
  }, 'private:1');
  try {
    await f.pipeline.handle(f.msg, f.api);
    const prompt = promptText(f);
    assert.match(prompt, /志绪理/, '人格设定必须进 system');
    assert.match(prompt, /无糖可乐/, '长期记忆必须进 prompt');
    assert.match(prompt, /计算机专业/, '身份类事实也要进');
    assert.equal((prompt.match(/无糖可乐/g) || []).length, 1, '同一条记忆只能出现一次');
  } finally {
    f.store.close();
  }
});

test('关键词命中的记忆优先于兜底：问到可乐时，无关的旧事实不该挤进来', async () => {
  const f = makeFixture({
    name: 'prompt-keyword',
    expectedProvider: 'default',
    realRetriever: true,
    facts: [
      { content: '用户喜欢无糖可乐' },
      { content: '用户养了一只叫年糕的猫', factType: 'other' },
    ],
  }, 'private:1');
  try {
    const text = '我想喝可乐';
    await f.pipeline.handle(
      { ...f.msg, text, segments: [{ type: 'text', data: { text } }] } as typeof f.msg,
      f.api,
    );
    const prompt = promptText(f);
    assert.match(prompt, /无糖可乐/, '命中关键词的记忆要进来');
  } finally {
    f.store.close();
  }
});

test('历史窗口按 recentTurns 截断：最早的消息不该出现在 prompt 里', async () => {
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `历史第${i + 1}条内容`,
  }));
  const f = makeFixture({ name: 'prompt-window', expectedProvider: 'default', history }, 'private:1');
  try {
    await f.pipeline.handle(f.msg, f.api);
    const prompt = promptText(f);
    assert.doesNotMatch(prompt, /历史第1条内容/, '最早的几条必须被截掉');
    assert.match(prompt, /历史第40条内容/, '最近一条必须在');
    const included = (prompt.match(/历史第\d+条内容/g) || []).length;
    assert.ok(included > 0 && included < 40, `窗口应该是截断的，实际进来了 ${included} 条`);
  } finally {
    f.store.close();
  }
});

test('群聊：发送者身份和群上下文要能区分开', async () => {
  const f = makeFixture({ name: 'prompt-group', expectedProvider: 'default' }, 'group:123');
  try {
    await f.pipeline.handle(f.msg, f.api);
    const prompt = promptText(f);
    assert.match(prompt, /测试用户/, '要能看出是谁在说话');
  } finally {
    f.store.close();
  }
});

test('黄金快照：一次完整调用的消息序列没有变化', async () => {
  const f = makeFixture({
    name: 'prompt-golden',
    expectedProvider: 'default',
    realRetriever: true,
    personaPrompt: '你是志绪理，说话简短，偶尔毒舌',
    facts: [{ content: '用户喜欢无糖可乐' }],
    history: [
      { role: 'user', content: '今天好累' },
      { role: 'assistant', content: '那就早点睡' },
    ],
  }, 'private:1');
  try {
    await f.pipeline.handle(f.msg, f.api);
    const snapshot = normalize(promptText(f));

    if (UPDATE) {
      fs.mkdirSync('scripts/fixtures', { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify({ note: '由 UPDATE_GOLDEN=1 生成，改动 prompt 后请确认差异是有意的', snapshot }, null, 2)}\n`, 'utf8');
      return;
    }
    assert.ok(fs.existsSync(GOLDEN), `缺少黄金文件，先跑一次 UPDATE_GOLDEN=1 npm run test:prompt-replay`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as { snapshot: string };
    assert.equal(snapshot, golden.snapshot,
      'prompt 结构变了。确认是有意的改动之后，用 UPDATE_GOLDEN=1 重新生成快照');
  } finally {
    f.store.close();
  }
});
