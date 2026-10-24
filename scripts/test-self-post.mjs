// 自发说说的时间调度与提示词。纯函数，不连 OneBot、不写状态文件。
//
//   node scripts/test-self-post.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPrompt, cleanPostText, pickTargets } from './self-post.mjs';

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime(); // 2026-10-24 周六 12:00
const clock = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('指定钟点：没有浮动时就是那个时间', () => {
  const [t] = pickTargets(NOW, { perDay: 1, times: ['20:30'], jitterMinutes: 0 }, () => 0);
  assert.equal(clock(t), '20:30');
});

test('指定钟点：浮动落在 ±jitter 之内', () => {
  const base = 20 * 60 + 30;
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const [t] = pickTargets(NOW, { perDay: 1, times: ['20:30'], jitterMinutes: 20 }, () => r);
    const d = new Date(t);
    const minutes = d.getHours() * 60 + d.getMinutes();
    assert.ok(Math.abs(minutes - base) <= 20, `rand=${r} 时偏移 ${minutes - base} 分钟，超出 ±20`);
  }
});

test('多个时间点按先后排序，perDay 决定取几个', () => {
  const list = pickTargets(NOW, { perDay: 2, times: ['21:00', '09:00'], jitterMinutes: 0 }, () => 0);
  assert.deepEqual(list.map(clock), ['09:00', '21:00']);

  const one = pickTargets(NOW, { perDay: 1, times: ['21:00', '09:00'], jitterMinutes: 0 }, () => 0);
  assert.deepEqual(one.map(clock), ['09:00'], 'perDay=1 只取最早那个');
});

test('时间点不够时循环使用，不会漏发', () => {
  const list = pickTargets(NOW, { perDay: 3, times: ['09:00'], jitterMinutes: 0 }, () => 0);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(clock), ['09:00', '09:00', '09:00']);
});

test('不填时间点：退回 activeFrom~activeTo 随机', () => {
  for (const r of [0, 0.5, 0.999]) {
    const [t] = pickTargets(NOW, { perDay: 1, activeFrom: '09:00', activeTo: '23:00' }, () => r);
    const d = new Date(t);
    const minutes = d.getHours() * 60 + d.getMinutes();
    assert.ok(minutes >= 9 * 60 && minutes < 23 * 60, `rand=${r} 落在 ${clock(t)}，超出窗口`);
  }
});

test('perDay 被夹在 1~5，坏时间点被忽略', () => {
  assert.equal(pickTargets(NOW, { perDay: 99, times: ['09:00'], jitterMinutes: 0 }, () => 0).length, 5);
  assert.equal(pickTargets(NOW, { perDay: 0, times: ['09:00'], jitterMinutes: 0 }, () => 0).length, 1);
  const list = pickTargets(NOW, { perDay: 1, times: ['25:99', 'abc', '08:15'], jitterMinutes: 0 }, () => 0);
  assert.deepEqual(list.map(clock), ['08:15'], '只保留合法时间点');
});

test('提示词带上时间、星期、季节和最近发过的内容', () => {
  const { system, user } = buildPostPrompt(
    { persona: 'shiori', style: { minChars: 20, maxChars: 60, topics: ['今天的心情'] } },
    { lifeLine: '在便利店买关东煮', time: '晚上', useEmoji: false },
    ['今天好热', '路灯坏了'],
    new Date(2026, 9, 24, 20, 30, 0),
  );
  assert.match(system, /10月24日 周六/);
  assert.match(system, /秋天的晚上/);
  assert.match(system, /在便利店买关东煮/);
  assert.match(system, /「今天好热」/);
  assert.match(system, /别重复这些的句式和开头/);
  assert.match(system, /20~60 字/);
  assert.match(user, /10月24日/);
});

test('提示词明确禁掉模板开头和书面词，且 emoji 跟着配置走', () => {
  const noEmoji = buildPostPrompt({ persona: 'x', style: {} }, { useEmoji: false }, [], new Date(NOW));
  assert.match(noEmoji.system, /不要用这些开头：今天也是/);
  assert.match(noEmoji.system, /仿佛/);
  assert.match(noEmoji.system, /不用任何 emoji/);

  const withEmoji = buildPostPrompt({ persona: 'x', style: {} }, { useEmoji: true, emoji: '🙃' }, [], new Date(NOW));
  assert.match(withEmoji.system, /可以带一个表情符号/);
  assert.doesNotMatch(withEmoji.system, /不用任何 emoji/);
});

test('清洗：去包裹引号、压空行、省略号归一', () => {
  assert.equal(cleanPostText('「今天好累……」'), '今天好累……');
  assert.equal(cleanPostText('"随便写写"'), '随便写写');
  assert.equal(cleanPostText('第一行\n\n\n\n第二行'), '第一行\n\n第二行');
  assert.equal(cleanPostText('好困........'), '好困……');
  assert.equal(cleanPostText('   '), '');
});
