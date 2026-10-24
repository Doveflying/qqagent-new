/**
 * 群级行为配置
 *
 * 全局配置解决「默认怎么表现」，这里解决「某个群想不一样」。
 * 存储是 config/groups.json，按群号索引，字段**出现才覆盖**、没出现就继承全局。
 *
 *   {
 *     "version": 1,
 *     "groups": {
 *       "1043219092": {
 *         "note": "摸鱼群",
 *         "trigger":  { "requireAt": false, "keywords": ["小绪"] },
 *         "proactive": { "enabled": true, "everyNMessages": 20, "maxPerHourPerScope": 1 },
 *         "quietHours": ["23:30-07:30"]
 *       }
 *     }
 *   }
 *
 * 读取按 mtime 缓存：面板保存后下一次判定就能看到新值，不需要重启。
 * 写入走 atomicWrite，避免半个 JSON 把配置读崩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './loader.js';
import { atomicWrite } from './atomic.js';
import type { AppConfig } from '../core/types.js';

export const GROUPS_PATH = path.join(PROJECT_ROOT, 'config', 'groups.json');

export interface GroupTriggerOverride {
  requireAt?: boolean;
  keywords?: string[];
  prefixes?: string[];
}

export interface GroupProactiveOverride {
  enabled?: boolean;
  everyNMessages?: number;
  maxPerHourPerScope?: number;
  minIntervalMs?: number;
}

export interface GroupOverride {
  note?: string;
  trigger?: GroupTriggerOverride;
  proactive?: GroupProactiveOverride;
  /** 免打扰时段，如 ["23:30-07:30"]；显式空数组 = 这个群不设免打扰 */
  quietHours?: string[];
}

export type GroupOverrides = Record<string, GroupOverride>;

export class GroupConfigError extends Error {}

const cache = new Map<string, { mtimeMs: number; size: number; data: GroupOverrides }>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function strList(v: unknown, max: number, maxLen: number): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new GroupConfigError('应为字符串数组');
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') throw new GroupConfigError('数组里只能放字符串');
    const s = item.trim();
    if (!s) continue;
    if (s.length > maxLen) throw new GroupConfigError(`单个条目不能超过 ${maxLen} 字`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > max) throw new GroupConfigError(`最多 ${max} 条`);
  return out;
}

const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function quietHoursList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new GroupConfigError('免打扰时段应为字符串数组');
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') throw new GroupConfigError('时段必须是字符串');
    const s = item.trim();
    if (!s) continue;
    const m = TIME_RANGE.exec(s);
    if (!m) throw new GroupConfigError(`时段格式应为 HH:MM-HH:MM：${s}`);
    const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) throw new GroupConfigError(`时间超出范围：${s}`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 6) throw new GroupConfigError('最多 6 个时段');
  return out;
}

function intIn(v: unknown, min: number, max: number, label: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new GroupConfigError(`${label} 应为 ${min}~${max} 的整数`);
  return n;
}

/** 严格校验（写入用）：有任何不合法就抛 GroupConfigError */
export function normalizeGroupOverride(input: unknown): GroupOverride {
  if (!isPlainObject(input)) throw new GroupConfigError('配置应为对象');
  const out: GroupOverride = {};

  if (input.note !== undefined) {
    if (typeof input.note !== 'string') throw new GroupConfigError('备注应为字符串');
    const note = input.note.trim();
    if (note.length > 60) throw new GroupConfigError('备注不能超过 60 字');
    if (note) out.note = note;
  }

  if (input.trigger !== undefined) {
    if (!isPlainObject(input.trigger)) throw new GroupConfigError('trigger 应为对象');
    const t: GroupTriggerOverride = {};
    if (input.trigger.requireAt !== undefined) {
      if (typeof input.trigger.requireAt !== 'boolean') throw new GroupConfigError('requireAt 应为布尔值');
      t.requireAt = input.trigger.requireAt;
    }
    const kw = strList(input.trigger.keywords, 20, 30);
    if (kw !== undefined) t.keywords = kw;
    const pf = strList(input.trigger.prefixes, 20, 10);
    if (pf !== undefined) t.prefixes = pf;
    if (Object.keys(t).length > 0) out.trigger = t;
  }

  if (input.proactive !== undefined) {
    if (!isPlainObject(input.proactive)) throw new GroupConfigError('proactive 应为对象');
    const p: GroupProactiveOverride = {};
    if (input.proactive.enabled !== undefined) {
      if (typeof input.proactive.enabled !== 'boolean') throw new GroupConfigError('proactive.enabled 应为布尔值');
      p.enabled = input.proactive.enabled;
    }
    const every = intIn(input.proactive.everyNMessages, 1, 500, 'everyNMessages');
    if (every !== undefined) p.everyNMessages = every;
    const perHour = intIn(input.proactive.maxPerHourPerScope, 0, 60, 'maxPerHourPerScope');
    if (perHour !== undefined) p.maxPerHourPerScope = perHour;
    const gap = intIn(input.proactive.minIntervalMs, 0, 24 * 3600 * 1000, 'minIntervalMs');
    if (gap !== undefined) p.minIntervalMs = gap;
    if (Object.keys(p).length > 0) out.proactive = p;
  }

  const quiet = quietHoursList(input.quietHours);
  if (quiet !== undefined) out.quietHours = quiet;

  return out;
}

/** 宽松读取：单条坏了只丢那一条，不让整个文件失效 */
function sanitize(raw: unknown): GroupOverrides {
  const out: GroupOverrides = {};
  if (!isPlainObject(raw)) return out;
  const groups = isPlainObject(raw.groups) ? raw.groups : {};
  for (const [key, value] of Object.entries(groups)) {
    const id = key.trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0) continue;
    try {
      const normalized = normalizeGroupOverride(value);
      if (Object.keys(normalized).length > 0) out[id] = normalized;
    } catch {
      /* 单条配置不合法就跳过 */
    }
  }
  return out;
}

/** 读全部覆盖（按 mtime + size 缓存，面板改完立刻生效） */
export function loadGroupOverrides(file: string = GROUPS_PATH): GroupOverrides {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch {
    return {};
  }
}

/** 整体写回（写入前逐条严格校验，任何一条不合法就整体失败） */
export function saveGroupOverrides(next: GroupOverrides, file: string = GROUPS_PATH): GroupOverrides {
  const clean: GroupOverrides = {};
  for (const [key, value] of Object.entries(next)) {
    const id = String(key).trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0) throw new GroupConfigError(`群号不合法：${key}`);
    const normalized = normalizeGroupOverride(value);
    if (Object.keys(normalized).length > 0) clean[id] = normalized;
  }
  atomicWrite(file, `${JSON.stringify({ version: 1, groups: clean }, null, 2)}\n`);
  cache.delete(file);
  return clean;
}

/** 取某个群的覆盖；群号非法或没配置都返回 undefined */
export function groupOverrideFor(
  groupId: number | string | undefined | null,
  file: string = GROUPS_PATH,
): GroupOverride | undefined {
  if (groupId === undefined || groupId === null) return undefined;
  const id = String(groupId).trim();
  if (!/^\d+$/.test(id)) return undefined;
  return loadGroupOverrides(file)[id];
}

/** 把群级覆盖合到全局触发规则上（字段出现才覆盖） */
export function mergedGroupTrigger(
  base: AppConfig['trigger']['group'],
  ov?: GroupOverride,
): AppConfig['trigger']['group'] {
  const t = ov?.trigger;
  if (!t) return base;
  return {
    ...base,
    requireAt: t.requireAt ?? base.requireAt,
    keywords: t.keywords ?? base.keywords,
    prefixes: t.prefixes ?? base.prefixes,
  };
}

/** 把群级覆盖合到全局主动发言配置上（字段出现才覆盖；quietHours 显式空数组 = 不设免打扰） */
export function mergedProactive(
  base: AppConfig['proactive'],
  ov?: GroupOverride,
): AppConfig['proactive'] {
  const p = ov?.proactive;
  const quietHours = ov?.quietHours ?? base.quietHours;
  if (!p && quietHours === base.quietHours) return base;
  return {
    ...base,
    enabled: p?.enabled ?? base.enabled,
    everyNMessages: p?.everyNMessages ?? base.everyNMessages,
    maxPerHourPerScope: p?.maxPerHourPerScope ?? base.maxPerHourPerScope,
    minIntervalMs: p?.minIntervalMs ?? base.minIntervalMs,
    quietHours,
  };
}

/** 某个会话实际生效的主动发言配置（群聊取群覆盖，私聊用全局） */
export function proactiveForScope(
  scope: string,
  base: AppConfig['proactive'],
  overrides: () => GroupOverrides = loadGroupOverrides,
): AppConfig['proactive'] {
  if (!scope.startsWith('group:')) return base;
  return mergedProactive(base, overrides()[scope.slice('group:'.length)]);
}

/** 某个会话实际生效的免打扰时段 */
export function quietHoursForScope(
  scope: string,
  base: AppConfig['proactive'],
  overrides: () => GroupOverrides = loadGroupOverrides,
): string[] {
  return proactiveForScope(scope, base, overrides).quietHours;
}
