// 「这条评论回过了吗」的判定逻辑。纯函数，不碰网络。
//
// 这里曾经有过一个 bug：只判断「她在这条评论之后发过言」，于是她回了 B 之后，
// 时间上更早的 A 也被判成已回，A 就永远等不到回复。判据加上「下一条他人评论」
// 这个上界之后才分得清她的回复到底是给谁的。
//
//   node scripts/test-qzone-logic.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alreadyAnswered } from './qzone-reply.mjs';

const SELF = 3823176415;
const OTHER = 2731758714;

/** 用分钟偏移拼评论，方便写时间线 */
const at = (min) => min * 60_000;
const c = (uin, min, content = 'x') => ({ uin, name: uin === SELF ? '她' : '对方', content, createdAt: at(min) });

test('她在这条评论之后回过，就算已回', () => {
  const comments = [c(OTHER, 0), c(SELF, 1)];
  assert.equal(alreadyAnswered(comments, comments[0], SELF), true);
});

test('她回的是后一条评论时，前一条仍算未回（旧实现会漏掉这条）', () => {
  const a = c(OTHER, 0);
  const b = c(OTHER, 1);
  const comments = [a, b, c(SELF, 2)]; // 她回的是 b
  assert.equal(alreadyAnswered(comments, a, SELF), false, 'A 不该被 B 的回复顺带标记成已回');
  assert.equal(alreadyAnswered(comments, b, SELF), true);
});

test('她的回复在两条评论之间，只算回了前一条', () => {
  const a = c(OTHER, 0);
  const b = c(OTHER, 10);
  const comments = [a, c(SELF, 5), b];
  assert.equal(alreadyAnswered(comments, a, SELF), true);
  assert.equal(alreadyAnswered(comments, b, SELF), false);
});

test('多条他人评论连续出现、她在最后回一句：只算回最后一条', () => {
  const list = [c(OTHER, 0), c(OTHER + 1, 1), c(OTHER + 2, 2)];
  const comments = [...list, c(SELF, 3)];
  assert.equal(alreadyAnswered(comments, list[0], SELF), false);
  assert.equal(alreadyAnswered(comments, list[1], SELF), false);
  assert.equal(alreadyAnswered(comments, list[2], SELF), true);
});

test('没有她的回复时一律未回', () => {
  const comments = [c(OTHER, 0), c(OTHER, 1)];
  assert.equal(alreadyAnswered(comments, comments[0], SELF), false);
  assert.equal(alreadyAnswered(comments, comments[1], SELF), false);
});

test('空列表不炸', () => {
  assert.equal(alreadyAnswered([], c(OTHER, 0), SELF), false);
});
