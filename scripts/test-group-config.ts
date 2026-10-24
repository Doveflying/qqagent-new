import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { AppConfigSchema, type InboundMessage } from '../src/core/types.js';
import {
  normalizeGroupOverride,
  saveGroupOverrides,
  loadGroupOverrides,
  mergedGroupTrigger,
  mergedProactive,
  proactiveForScope,
  GroupConfigError,
  type GroupOverrides,
} from '../src/config/groups.js';
import { TriggerPolicy } from '../src/persona/trigger.js';
import { ProactiveSpeaker } from '../src/persona/proactive.js';
import { MemoryStore } from '../src/memory/store.js';

const log = pino({ level: 'silent' });

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-groups-'));
  return path.join(dir, 'groups.json');
}

function cleanup(file: string) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

function groupMsg(text: string, opts: { mentionsBot?: boolean; groupId?: number } = {}): InboundMessage {
  return {
    scope: `group:${opts.groupId ?? 100}`,
    scopeType: 'group',
    groupId: opts.groupId ?? 100,
    userId: 42,
    selfId: 999,
    nickname: '测试',
    text,
    segments: [{ type: 'text', data: { text } }],
    mentionsBot: opts.mentionsBot ?? false,
    repliesToBot: false,
    messageId: 1,
    time: Date.now(),
  } as unknown as InboundMessage;
}

test('校验：非法群配置被拒，合法的被规整', () => {
  assert.throws(() => normalizeGroupOverride(null), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ quietHours: ['25:00-08:00'] }), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ quietHours: ['23:00'] }), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ proactive: { everyNMessages: 0 } }), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ proactive: { maxPerHourPerScope: 99 } }), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ trigger: { keywords: 'a' } }), GroupConfigError);
  assert.throws(() => normalizeGroupOverride({ trigger: { keywords: Array.from({ length: 21 }, (_, i) => 'k' + i) } }), GroupConfigError);

  const ok = normalizeGroupOverride({
    note: '  摸鱼群  ',
    trigger: { requireAt: false, keywords: [' 小绪 ', '小绪', ''] },
    proactive: { enabled: true, everyNMessages: 20, maxPerHourPerScope: 0 },
    quietHours: ['23:30-07:30'],
  });
  assert.equal(ok.note, '摸鱼群');
  assert.deepEqual(ok.trigger?.keywords, ['小绪'], '去重去空');
  assert.equal(ok.proactive?.maxPerHourPerScope, 0, '0 = 不限制，要保留');
  assert.deepEqual(ok.quietHours, ['23:30-07:30']);
});

test('读写往返：保存后能读回来，单条坏数据不拖垮整个文件', () => {
  const file = tmpFile();
  try {
    saveGroupOverrides({
      100: { note: 'A', trigger: { requireAt: false } },
      200: { quietHours: [] },
    }, file);
    const back = loadGroupOverrides(file);
    assert.equal(back['100']?.note, 'A');
    assert.equal(back['100']?.trigger?.requireAt, false);
    assert.deepEqual(back['200']?.quietHours, [], '显式空数组要保留（= 不设免打扰）');

    // 手写一份带坏条目的文件：好的留下，坏的丢掉
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      groups: {
        100: { note: 'ok' },
        200: { quietHours: ['不是时间'] },
        abc: { note: '群号非法' },
        300: { proactive: { everyNMessages: 9999 } },
      },
    }));
    const lenient = loadGroupOverrides(file);
    assert.equal(lenient['100']?.note, 'ok');
    assert.equal(lenient['200'], undefined);
    assert.equal(lenient['abc'], undefined);
    assert.equal(lenient['300'], undefined);
  } finally {
    cleanup(file);
  }
});

test('合并：字段出现才覆盖，没出现的继承全局', () => {
  const cfg = AppConfigSchema.parse({});
  const base = cfg.trigger.group;
  const basePro = cfg.proactive;

  const same = mergedGroupTrigger(base, undefined);
  assert.equal(same, base, '没有覆盖时直接复用全局对象');

  const merged = mergedGroupTrigger(base, { trigger: { requireAt: false, keywords: ['小绪'] } });
  assert.equal(merged.requireAt, false);
  assert.deepEqual(merged.keywords, ['小绪']);
  assert.deepEqual(merged.prefixes, base.prefixes, '没写的字段继承');
  assert.equal(merged.cooldownMs, base.cooldownMs);

  const pro = mergedProactive(basePro, { proactive: { everyNMessages: 30 }, quietHours: [] });
  assert.equal(pro.everyNMessages, 30);
  assert.deepEqual(pro.quietHours, [], '显式空数组 = 这个群不设免打扰');
  assert.equal(pro.minIntervalMs, basePro.minIntervalMs);
  assert.equal(pro.mode, basePro.mode);
});

test('按会话取配置：群用覆盖、私聊用全局、没配的群用全局', () => {
  const cfg = AppConfigSchema.parse({});
  const overrides: GroupOverrides = { '100': { proactive: { enabled: false } } };
  const get = () => overrides;

  assert.equal(proactiveForScope('group:100', cfg.proactive, get).enabled, false);
  assert.equal(proactiveForScope('group:200', cfg.proactive, get).enabled, cfg.proactive.enabled, '没配的群继承全局');
  assert.equal(proactiveForScope('private:1', cfg.proactive, get).enabled, cfg.proactive.enabled, '私聊不受群覆盖影响');
});

test('触发规则：这个群不要求 @，关键词就能唤起', () => {
  const cfg = AppConfigSchema.parse({});
  const overrides: GroupOverrides = { '100': { trigger: { requireAt: false, keywords: ['小绪'] } } };
  const policy = new TriggerPolicy(cfg.trigger, log, () => overrides);

  const hit = policy.decide(groupMsg('小绪在吗'), 999);
  assert.equal(hit.reply, true);
  assert.match(hit.reply ? hit.reason : '', /关键词/);

  const miss = policy.decide(groupMsg('今天吃什么'), 999);
  assert.equal(miss.reply, false);

  // 没配覆盖的群仍然要求 @
  const other = policy.decide(groupMsg('小绪在吗', { groupId: 200 }), 999);
  assert.equal(other.reply, false);
  assert.match(other.reply ? '' : other.reason, /@/);

  // @ 了照样回，不受覆盖影响
  const at = policy.decide(groupMsg('随便说点什么', { mentionsBot: true }), 999);
  assert.equal(at.reply, true);
});

test('主动发言：群级关闭后，即使全局开着也不插话', () => {
  const cfg = AppConfigSchema.parse({ proactive: { enabled: true, mode: 'hybrid' } });
  const store = new MemoryStore(':memory:');
  const overrides: GroupOverrides = { '100': { proactive: { enabled: false } } };
  try {
    const speaker = new ProactiveSpeaker(cfg.proactive, store, log, undefined, () => overrides);
    const ctx = {
      scope: 'group:100',
      scopeType: 'group' as const,
      recentMessages: [{ senderName: 'a', text: '随便聊聊', timestamp: Date.now() }],
      lastBotMessageAt: 0,
      relevance: 0,
      addressed: false,
      messagesSinceBot: 99,
    };
    const off = speaker.decide(ctx);
    assert.equal(off.speak, false);
    assert.match(off.speak ? '' : off.reason, /主动发言已关闭/);

    // 换个没配覆盖的群，配置照常
    const on = speaker.decide({ ...ctx, scope: 'group:200' });
    assert.equal(on.speak ? true : on.reason !== '主动发言已关闭', true);
  } finally {
    store.close();
  }
});
