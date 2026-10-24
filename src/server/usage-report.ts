/**
 * 用量与成本
 *
 * 回答三个问题：今天花了多少、钱花在哪个模型/哪个环节、是不是突然变贵了。
 *
 * 数据全部来自 llm_calls（provider / model / purpose / tokens / created_at），
 * 单价来自 config/usage.json —— **这里算的是估算值**，不是账单：
 * 中转站加价、缓存命中、阶梯价都算不出来。面板上会标明「按配置单价估算」。
 *
 * 未配置单价的模型退回 `*` 兜底单价；连兜底都没有就只统计 token，不计入金额。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT } from '../config/loader.js';

export const USAGE_PATH = path.join(PROJECT_ROOT, 'config', 'usage.json');

export interface PriceEntry {
  input: number;
  output: number;
}

export interface UsageConfig {
  currency: string;
  /** 每多少 token 计价，默认 1e6（百万） */
  unit: number;
  /** 键可以是 `provider/model`、`model` 或 `*` */
  pricing: Record<string, PriceEntry>;
  budget: { daily: number; monthly: number; alertRatio: number };
}

const DEFAULT_CONFIG: UsageConfig = {
  currency: 'CNY',
  unit: 1_000_000,
  pricing: {
    'deepseek/deepseek-chat': { input: 2, output: 8 },
    'deepseek/deepseek-reasoner': { input: 4, output: 16 },
    'zhipu/glm-4-flash': { input: 0, output: 0 },
    // 兜底单价：命中不了具体模型时用它，宁可粗略也别显示 0
    '*': { input: 2, output: 8 },
  },
  budget: { daily: 2, monthly: 30, alertRatio: 0.8 },
};

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function rows(db: DatabaseSync, sql: string, params: Array<string | number> = []): Row[] {
  try {
    return db.prepare(sql).all(...params) as unknown as Row[];
  } catch {
    return [];
  }
}

/** 读配置：缺文件用内置默认值；坏文件也退回默认值（成本统计不该因为配置写坏就崩） */
export function loadUsageConfig(file: string = USAGE_PATH): UsageConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UsageConfig>;
    const pricing: Record<string, PriceEntry> = {};
    for (const [key, value] of Object.entries(raw.pricing ?? {})) {
      const input = Number((value as PriceEntry)?.input);
      const output = Number((value as PriceEntry)?.output);
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
        pricing[key] = { input, output };
      }
    }
    return {
      currency: String(raw.currency || DEFAULT_CONFIG.currency),
      unit: Number(raw.unit) > 0 ? Number(raw.unit) : DEFAULT_CONFIG.unit,
      pricing: Object.keys(pricing).length > 0 ? pricing : DEFAULT_CONFIG.pricing,
      budget: {
        daily: Math.max(0, Number(raw.budget?.daily ?? DEFAULT_CONFIG.budget.daily) || 0),
        monthly: Math.max(0, Number(raw.budget?.monthly ?? DEFAULT_CONFIG.budget.monthly) || 0),
        alertRatio: Math.min(1, Math.max(0.1, Number(raw.budget?.alertRatio ?? DEFAULT_CONFIG.budget.alertRatio))),
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 查单价：`provider/model` → `model` → `*`，都没命中返回 undefined */
export function priceFor(cfg: UsageConfig, provider: string, model: string): { price?: PriceEntry; exact: boolean } {
  const exactKey = `${provider}/${model}`;
  if (cfg.pricing[exactKey]) return { price: cfg.pricing[exactKey], exact: true };
  if (cfg.pricing[model]) return { price: cfg.pricing[model], exact: true };
  if (cfg.pricing['*']) return { price: cfg.pricing['*'], exact: false };
  return { exact: false };
}

export function costOf(cfg: UsageConfig, provider: string, model: string, promptTokens: number, completionTokens: number): { cost: number; priced: boolean; exact: boolean } {
  const { price, exact } = priceFor(cfg, provider, model);
  if (!price) return { cost: 0, priced: false, exact: false };
  const unit = cfg.unit || 1_000_000;
  return { cost: (promptTokens / unit) * price.input + (completionTokens / unit) * price.output, priced: true, exact };
}

export type BudgetLevel = 'ok' | 'warn' | 'over' | 'unset';

export interface UsageReport {
  ok: true;
  generatedAt: number;
  currency: string;
  unit: number;
  today: { cost: number; tokens: number; calls: number; unpricedCalls: number };
  month: { cost: number; tokens: number; calls: number };
  budget: {
    daily: number;
    monthly: number;
    alertRatio: number;
    dailyRatio: number;
    monthlyRatio: number;
    level: BudgetLevel;
    message: string;
  };
  /** 今日 vs 近 7 天日均，判断「是不是突然变贵」 */
  spike: { level: 'ok' | 'warn'; ratio: number; baseline: number; message: string };
  byModel: Array<{ provider: string; model: string; calls: number; promptTokens: number; completionTokens: number; cost: number; exact: boolean }>;
  byPurpose: Array<{ purpose: string; calls: number; tokens: number; cost: number }>;
  days: Array<{ day: string; cost: number; tokens: number; calls: number }>;
}

function startOfDay(d = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const PURPOSE_LABELS: Record<string, string> = {
  chat: '对话',
  facts: '事实抽取',
  emotion: '情绪分析',
  summary: '摘要压缩',
  embedding: '向量化',
  asr: '语音识别',
  tts: '语音合成',
  vision: '图片理解',
  title: '话题标题',
  persona: '人格生成',
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? (purpose || '其他');
}

export function buildUsageReport(db: DatabaseSync, now = Date.now(), config?: UsageConfig): UsageReport {
  const cfg = config ?? loadUsageConfig();
  const todayStart = startOfDay(new Date(now));
  const monthStart = (() => {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const weekStart = todayStart - 6 * 86400000;
  const daysStart = todayStart - 13 * 86400000;

  // 今日/本月：按模型分组后再算钱，才能套上各自的单价
  const aggregate = (since: number) => {
    const list = rows(db, `SELECT provider, model, COUNT(*) AS calls,
                                  COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
                             FROM llm_calls WHERE created_at >= ?
                            GROUP BY provider, model`, [since]);
    let cost = 0;
    let tokens = 0;
    let calls = 0;
    let unpriced = 0;
    for (const r of list) {
      const promptTokens = num(r.p);
      const completionTokens = num(r.c);
      const c = num(r.calls);
      const money = costOf(cfg, str(r.provider), str(r.model), promptTokens, completionTokens);
      cost += money.cost;
      tokens += promptTokens + completionTokens;
      calls += c;
      if (!money.priced) unpriced += c;
    }
    return { cost, tokens, calls, unpriced };
  };

  const todayAgg = aggregate(todayStart);
  const today = { ...todayAgg, unpricedCalls: todayAgg.unpriced };
  const monthAgg = aggregate(monthStart);
  const month = { cost: monthAgg.cost, tokens: monthAgg.tokens, calls: monthAgg.calls };

  // 近 7 天按模型
  const byModel = rows(db, `SELECT provider, model, COUNT(*) AS calls,
                                   COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
                              FROM llm_calls WHERE created_at >= ?
                             GROUP BY provider, model ORDER BY (p + c) DESC LIMIT 12`, [weekStart])
    .map((r) => {
      const promptTokens = num(r.p);
      const completionTokens = num(r.c);
      const money = costOf(cfg, str(r.provider), str(r.model), promptTokens, completionTokens);
      return {
        provider: str(r.provider),
        model: str(r.model),
        calls: num(r.calls),
        promptTokens,
        completionTokens,
        cost: money.cost,
        exact: money.exact,
      };
    })
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls);

  // 近 7 天按环节：钱到底花在聊天还是抽事实/情绪/语音上
  const byPurpose = rows(db, `SELECT purpose, COUNT(*) AS calls,
                                     COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
                                FROM llm_calls WHERE created_at >= ?
                               GROUP BY purpose ORDER BY (p + c) DESC LIMIT 12`, [weekStart])
    .map((r) => {
      const tokens = num(r.p) + num(r.c);
      // 环节里混着多个模型，按各模型金额累加
      const perModel = rows(db, `SELECT provider, model, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
                                   FROM llm_calls WHERE created_at >= ? AND purpose = ?
                                  GROUP BY provider, model`, [weekStart, str(r.purpose)]);
      const cost = perModel.reduce((n, m) => n + costOf(cfg, str(m.provider), str(m.model), num(m.p), num(m.c)).cost, 0);
      return { purpose: str(r.purpose), calls: num(r.calls), tokens, cost };
    })
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // 近 14 天趋势
  const dayRows = rows(db, `SELECT created_at, provider, model, prompt_tokens, completion_tokens
                              FROM llm_calls WHERE created_at >= ?`, [daysStart]);
  const dayMap = new Map<string, { cost: number; tokens: number; calls: number }>();
  for (let i = 13; i >= 0; i--) dayMap.set(dayLabel(todayStart - i * 86400000), { cost: 0, tokens: 0, calls: 0 });
  for (const r of dayRows) {
    const key = dayLabel(num(r.created_at));
    const bucket = dayMap.get(key);
    if (!bucket) continue;
    const p = num(r.prompt_tokens);
    const c = num(r.completion_tokens);
    bucket.cost += costOf(cfg, str(r.provider), str(r.model), p, c).cost;
    bucket.tokens += p + c;
    bucket.calls += 1;
  }
  const days = [...dayMap].map(([day, v]) => ({ day, ...v }));

  // 预算
  const dailyRatio = cfg.budget.daily > 0 ? today.cost / cfg.budget.daily : 0;
  const monthlyRatio = cfg.budget.monthly > 0 ? month.cost / cfg.budget.monthly : 0;
  let level: BudgetLevel = 'unset';
  if (cfg.budget.daily > 0 || cfg.budget.monthly > 0) {
    level = 'ok';
    if (dailyRatio >= 1 || monthlyRatio >= 1) level = 'over';
    else if (dailyRatio >= cfg.budget.alertRatio || monthlyRatio >= cfg.budget.alertRatio) level = 'warn';
  }
  const message =
    level === 'unset' ? '还没设预算（config/usage.json 的 budget）'
      : level === 'over' ? `已超预算：今日 ${today.cost.toFixed(2)} / ${cfg.budget.daily}，本月 ${month.cost.toFixed(2)} / ${cfg.budget.monthly}`
        : level === 'warn' ? `接近预算上限（今日已用 ${Math.round(dailyRatio * 100)}%）`
          : '预算充足';

  // 突增检测：今日 vs 近 7 天日均（不含今天）
  const past = days.slice(0, 7).filter((d) => d.calls > 0);
  const baseline = past.length > 0 ? past.reduce((n, d) => n + d.cost, 0) / past.length : 0;
  const ratio = baseline > 0 ? today.cost / baseline : 0;
  const spikeWarn = baseline > 0.01 && ratio >= 2.5;
  const spike = {
    level: spikeWarn ? ('warn' as const) : ('ok' as const),
    ratio,
    baseline,
    message: spikeWarn
      ? `今日花费是近 7 天日均的 ${ratio.toFixed(1)} 倍（${today.cost.toFixed(2)} vs ${baseline.toFixed(2)}）`
      : '',
  };

  return {
    ok: true,
    generatedAt: now,
    currency: cfg.currency,
    unit: cfg.unit,
    today,
    month,
    budget: {
      daily: cfg.budget.daily,
      monthly: cfg.budget.monthly,
      alertRatio: cfg.budget.alertRatio,
      dailyRatio,
      monthlyRatio,
      level,
      message,
    },
    spike,
    byModel,
    byPurpose,
    days,
  };
}
