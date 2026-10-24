/**
 * 健康中心
 *
 * 把「Agent 现在到底好不好」拆成一组可解释的检查项，而不是只回一个 connected: true。
 * 每个检查项都带权重、得分（0~1）、依据和处置建议；总分 = Σ(权重 × 得分)，
 * 所以面板能逐项说明「为什么是 82 分」，而不是给一个说不清来历的数字。
 *
 * 数据全部来自本地已有记录，不额外发网络请求：
 *  - runtime()          OneBot 连接与账号就绪
 *  - llm_calls          模型调用成功/失败、延迟、失败原因（24h 窗口）
 *  - reply_deliveries   回复投递结果
 *  - scheduled_tasks    定时任务状态与运行记录
 *  - brain.db 体积、fact_embeddings 覆盖率
 *
 * 只读：所有查询都在 try/catch 里，老库缺表缺列时该项退化为 unknown，不会让面板 500。
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const OVERDUE_GRACE_MS = 120_000;

export type HealthStatus = 'ok' | 'warn' | 'error' | 'unknown';

export interface HealthRuntime {
  napcatConnected: boolean;
  onebot?: {
    connected: boolean;
    accountReady: boolean;
    apiReady: boolean;
    generation: number;
    pending: number;
    bufferedBytes: number;
    implementation: { name: string; version: string; protocol: string };
    extensions: Record<string, string>;
  };
  selfId: number;
  nickname: string;
  uptimeMs: number;
  startedAt: number;
}

export interface HealthInput {
  runtime: HealthRuntime;
  db: DatabaseSync;
  stats: { users: number; sessions: number; messages: number; facts: number; summaries: number; emotionRecords: number };
  embedding: { total: number; models: Array<{ model: string; count: number }> };
  /** 数据库文件路径，用来算体积；拿不到就跳过存储体积这一项 */
  dbPath?: string;
  now?: number;
}

export interface HealthCheck {
  id: string;
  label: string;
  /** 权重，所有检查项之和为 100 */
  weight: number;
  /** 0~1 */
  score: number;
  status: HealthStatus;
  /** 依据：这一项看到了什么 */
  detail: string;
  /** 处置建议：状态不是 ok 时该做什么 */
  hint: string;
}

export interface ModelAvailability {
  provider: string;
  model: string;
  calls: number;
  ok: number;
  fail: number;
  /** 主动取消（用户打断等），不计入成功率分母 */
  cancelled: number;
  /** 24h 成功率，0~1；没有有效调用时为 null */
  successRate: number | null;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  lastAt: number | null;
  lastError: string;
  lastErrorAt: number | null;
  promptTokens: number;
  completionTokens: number;
  status: HealthStatus;
}

export interface HealthFailure {
  at: number;
  kind: 'model' | 'task' | 'delivery';
  title: string;
  detail: string;
}

export interface TrendBucket {
  at: number;
  ok: number;
  fail: number;
}

export interface HealthSnapshot {
  ok: true;
  generatedAt: number;
  windowMs: number;
  score: number;
  grade: HealthStatus;
  gradeLabel: string;
  summary: string;
  checks: HealthCheck[];
  models: ModelAvailability[];
  trend: TrendBucket[];
  failures: HealthFailure[];
  tasks: {
    pending: number;
    sent: number;
    failed: number;
    unknown: number;
    overdue: number;
    nextDueAt: number | null;
    recentRuns: Array<{ taskId: string; status: string; at: number; error: string }>;
  };
  delivery: { total: number; success: number; partial: number; failed: number; unknown: number };
  storage: {
    dbBytes: number | null;
    walBytes: number | null;
    messages: number;
    facts: number;
    embeddingTotal: number;
    /** 有向量的事实占比，0~1；没有事实时为 null */
    embeddingCoverage: number | null;
  };
}

type Row = Record<string, unknown>;

function rows(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row[] {
  try {
    return db.prepare(sql).all(...params) as unknown as Row[];
  } catch {
    return [];
  }
}

function one(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row | undefined {
  try {
    return db.prepare(sql).get(...params) as unknown as Row | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按顺序试多个 SQL，第一个能跑通的生效。
 * 用来兼容「老库还没有某列」的情况：带新列的查询失败时退回不带新列的版本，
 * 而不是整段数据变成空。
 */
function rowsAny(db: DatabaseSync, variants: string[], params: Array<string | number>): Row[] {
  for (const sql of variants) {
    try {
      return db.prepare(sql).all(...params) as unknown as Row[];
    } catch {
      /* 换下一个变体 */
    }
  }
  return [];
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function check(
  id: string,
  label: string,
  weight: number,
  score: number,
  status: HealthStatus,
  detail: string,
  hint: string,
): HealthCheck {
  return { id, label, weight, score: clamp01(score), status, detail, hint };
}

function fileSize(p: string | undefined): number | null {
  if (!p) return null;
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return '未知';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 成功率 → 得分与状态。阈值集中在这里，面板文案与测试都按同一套走。 */
function rateScore(rate: number): { score: number; status: HealthStatus } {
  if (rate >= 0.98) return { score: 1, status: 'ok' };
  if (rate >= 0.9) return { score: 0.8, status: 'warn' };
  if (rate >= 0.7) return { score: 0.5, status: 'error' };
  return { score: 0.2, status: 'error' };
}

export function buildHealthSnapshot(input: HealthInput): HealthSnapshot {
  const { runtime, db, stats, embedding } = input;
  const now = input.now ?? Date.now();
  const since = now - HEALTH_WINDOW_MS;
  const ob = runtime.onebot;

  // ---------- 模型调用（24h） ----------
  const modelRows = rows(
    db,
    `SELECT provider, model, COUNT(*) AS calls, SUM(success) AS ok,
            AVG(CASE WHEN success=1 THEN latency_ms END) AS avgLatency,
            MAX(latency_ms) AS maxLatency,
            MAX(created_at) AS lastAt,
            SUM(CASE WHEN success=1 THEN prompt_tokens ELSE 0 END) AS promptTokens,
            SUM(CASE WHEN success=1 THEN completion_tokens ELSE 0 END) AS completionTokens
       FROM llm_calls WHERE created_at >= ?
      GROUP BY provider, model ORDER BY calls DESC`,
    since,
  );
  // 单独查取消次数：老库没有 error_kind 列时这条会失败并返回空数组，
  // 整张表的统计不会因此消失（比把 error_kind 塞进主查询更稳）。
  const cancelledRows = rows(
    db,
    `SELECT provider, model, COUNT(*) AS n FROM llm_calls
      WHERE created_at >= ? AND success=0 AND error_kind='cancelled' GROUP BY provider, model`,
    since,
  );
  const cancelledByModel = new Map<string, number>();
  for (const r of cancelledRows) cancelledByModel.set(`${str(r.provider)}/${str(r.model)}`, num(r.n));

  const failureRows = rowsAny(
    db,
    [
      `SELECT provider, model, purpose, latency_ms, retry, created_at, error, error_kind
         FROM llm_calls WHERE success=0 AND created_at >= ? ORDER BY created_at DESC LIMIT 200`,
      `SELECT provider, model, purpose, latency_ms, retry, created_at, error
         FROM llm_calls WHERE success=0 AND created_at >= ? ORDER BY created_at DESC LIMIT 200`,
    ],
    [since],
  ).filter((r) => str(r.error_kind) !== 'cancelled');

  const lastErrorByModel = new Map<string, { error: string; at: number }>();
  for (const r of failureRows) {
    const key = `${str(r.provider)}/${str(r.model)}`;
    if (lastErrorByModel.has(key)) continue; // 已按时间倒序，第一条就是最近的
    lastErrorByModel.set(key, { error: str(r.error), at: num(r.created_at) });
  }

  let totalCalls = 0;
  let totalOk = 0;
  const models: ModelAvailability[] = modelRows.map((r) => {
    const calls = num(r.calls);
    const ok = num(r.ok);
    const cancelled = cancelledByModel.get(`${str(r.provider)}/${str(r.model)}`) ?? 0;
    const fail = Math.max(0, calls - ok - cancelled);
    // 主动取消不算模型的锅：从分母里摘出去，否则用户一打断成功率就掉
    const effective = calls - cancelled;
    const rate = effective > 0 ? ok / effective : null;
    totalCalls += effective;
    totalOk += ok;
    const lastErr = lastErrorByModel.get(`${str(r.provider)}/${str(r.model)}`);
    return {
      provider: str(r.provider),
      model: str(r.model),
      calls,
      ok,
      fail,
      cancelled,
      successRate: rate,
      avgLatencyMs: r.avgLatency == null ? null : Math.round(num(r.avgLatency)),
      maxLatencyMs: r.maxLatency == null ? null : Math.round(num(r.maxLatency)),
      lastAt: r.lastAt == null ? null : num(r.lastAt),
      lastError: lastErr?.error ?? '',
      lastErrorAt: lastErr?.at ?? null,
      promptTokens: num(r.promptTokens),
      completionTokens: num(r.completionTokens),
      status: rate == null ? 'unknown' : rateScore(rate).status,
    };
  });
  const overallRate = totalCalls > 0 ? totalOk / totalCalls : null;

  // ---------- 投递（24h） ----------
  const deliveryRows = rows(
    db,
    'SELECT state, COUNT(*) AS n FROM reply_deliveries WHERE created_at >= ? GROUP BY state',
    since,
  );
  const delivery = { total: 0, success: 0, partial: 0, failed: 0, unknown: 0 };
  for (const r of deliveryRows) {
    const n = num(r.n);
    delivery.total += n;
    const s = str(r.state);
    if (s === 'success' || s === 'partial' || s === 'failed' || s === 'unknown') delivery[s] += n;
  }

  // ---------- 定时任务 ----------
  const taskRows = rows(db, 'SELECT state, COUNT(*) AS n, MIN(due_at) AS nextDue FROM scheduled_tasks GROUP BY state');
  const tasks = { pending: 0, sent: 0, failed: 0, unknown: 0, overdue: 0, nextDueAt: null as number | null, recentRuns: [] as HealthSnapshot['tasks']['recentRuns'] };
  for (const r of taskRows) {
    const s = str(r.state);
    const n = num(r.n);
    if (s === 'pending' || s === 'sent' || s === 'failed' || s === 'unknown') tasks[s] += n;
    if (s === 'pending' && r.nextDue != null) tasks.nextDueAt = num(r.nextDue);
  }
  const overdue = one(
    db,
    "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE state='pending' AND due_at < ?",
    now - OVERDUE_GRACE_MS,
  );
  tasks.overdue = num(overdue?.n);
  const taskRunRows = rows(
    db,
    `SELECT task_id, status, error, created_at FROM scheduled_task_runs
      WHERE created_at >= ? AND status <> 'sent' ORDER BY created_at DESC LIMIT 20`,
    since,
  );
  tasks.recentRuns = taskRunRows.map((r) => ({
    taskId: str(r.task_id),
    status: str(r.status),
    at: num(r.created_at),
    error: str(r.error),
  }));

  // ---------- 存储与索引 ----------
  const dbBytes = fileSize(input.dbPath);
  const walBytes = input.dbPath ? fileSize(`${input.dbPath}-wal`) : null;
  const embeddingCoverage = stats.facts > 0 ? clamp01(embedding.total / stats.facts) : null;
  const storage = {
    dbBytes,
    walBytes,
    messages: stats.messages,
    facts: stats.facts,
    embeddingTotal: embedding.total,
    embeddingCoverage,
  };

  // ---------- 趋势（最近 24 个整点桶） ----------
  const trendRows = rows(
    db,
    `SELECT (created_at / ${HOUR}) * ${HOUR} AS bucket, COUNT(*) AS calls, SUM(success) AS ok
       FROM llm_calls WHERE created_at >= ? GROUP BY bucket`,
    since,
  );
  const byBucket = new Map<number, { ok: number; fail: number }>();
  for (const r of trendRows) {
    const bucket = num(r.bucket);
    const calls = num(r.calls);
    const ok = num(r.ok);
    byBucket.set(bucket, { ok, fail: Math.max(0, calls - ok) });
  }
  const currentBucket = Math.floor(now / HOUR) * HOUR;
  const trend: TrendBucket[] = [];
  for (let i = 23; i >= 0; i--) {
    const at = currentBucket - i * HOUR;
    const hit = byBucket.get(at);
    trend.push({ at, ok: hit?.ok ?? 0, fail: hit?.fail ?? 0 });
  }

  // ---------- 检查项 ----------
  const checks: HealthCheck[] = [];

  // 1) OneBot 连接（25）
  const impl = ob?.implementation;
  const implLabel = impl && impl.name ? `${impl.name} ${impl.version}`.trim() : 'OneBot';
  if (!runtime.napcatConnected) {
    checks.push(check('onebot', 'OneBot 连接', 25, 0, 'error',
      `${implLabel} 未连接`,
      '打开「扫码登录」重新生成二维码；连续掉线时先看该页下方的登录日志'));
  } else if (!ob?.accountReady) {
    checks.push(check('onebot', 'OneBot 连接', 25, 0.6, 'warn',
      `${implLabel} 已连接，但账号尚未就绪`,
      '等几秒让账号完成初始化；若一直如此，强制重登一次'));
  } else if (!ob?.apiReady) {
    checks.push(check('onebot', 'OneBot 连接', 25, 0.75, 'warn',
      `${implLabel} 账号已就绪，API 尚未就绪`,
      '通常是 NapCat 正在加载扩展，稍等；持续不恢复就重启 NapCat'));
  } else {
    checks.push(check('onebot', 'OneBot 连接', 25, 1, 'ok',
      `${implLabel} 在线 · 第 ${num(ob.generation)} 代连接 · 待处理 ${num(ob.pending)} 个请求`,
      ''));
  }

  // 2) 模型可用性（25）
  if (overallRate == null) {
    checks.push(check('llm', '模型调用', 25, 0.7, 'unknown',
      '最近 24 小时没有模型调用记录',
      '随便发一条消息验证链路；若确实没在用，这项可以忽略'));
  } else {
    const rs = rateScore(overallRate);
    const failed = totalCalls - totalOk;
    checks.push(check('llm', '模型调用', 25, rs.score, rs.status,
      `24 小时 ${totalCalls} 次调用，成功 ${totalOk} 次，失败 ${failed} 次（成功率 ${(overallRate * 100).toFixed(1)}%）`,
      rs.status === 'ok' ? '' : '看下方「最近失败」的具体原因；连续失败时到「模型接入」测一次连接或切换默认模型'));
  }

  // 3) 回复投递（15）
  if (delivery.total === 0) {
    checks.push(check('delivery', '回复投递', 15, 0.8, 'unknown',
      '最近 24 小时没有回复投递记录',
      '没有对话时属正常；如果明明在聊却为 0，检查 OneBot 是否被别的实例占用'));
  } else {
    const bad = delivery.failed + delivery.unknown;
    const badRate = bad / delivery.total;
    const status: HealthStatus = badRate === 0 ? 'ok' : badRate <= 0.05 ? 'warn' : 'error';
    const score = badRate === 0 ? 1 : badRate <= 0.05 ? 0.8 : badRate <= 0.2 ? 0.5 : 0.2;
    checks.push(check('delivery', '回复投递', 15, score, status,
      `24 小时 ${delivery.total} 条回复：成功 ${delivery.success} · 部分 ${delivery.partial} · 失败 ${delivery.failed} · 结果未知 ${delivery.unknown}`,
      status === 'ok' ? '' : '多为发送超时或分片失败；「结果未知」表示已发出但没拿到回执，不要直接重发，先看日志确认'));
  }

  // 4) 定时任务（15）
  const taskIssues = tasks.overdue + tasks.failed;
  if (taskIssues === 0) {
    checks.push(check('tasks', '定时任务', 15, 1, 'ok',
      `待执行 ${tasks.pending} · 已投递 ${tasks.sent} · 逾期 ${tasks.overdue}`,
      ''));
  } else {
    const score = 1 - Math.min(1, tasks.overdue * 0.35 + tasks.failed * 0.25);
    checks.push(check('tasks', '定时任务', 15, score, tasks.overdue > 0 ? 'error' : 'warn',
      `待执行 ${tasks.pending} · 逾期 ${tasks.overdue} · 失败 ${tasks.failed} · 结果未知 ${tasks.unknown}`,
      '到「提醒与日报」看运行记录里的报错；逾期任务通常是因为发送时 OneBot 离线'));
  }

  // 5) 存储体积（10）
  if (dbBytes == null) {
    checks.push(check('storage', '数据库', 10, 0.8, 'unknown',
      `消息 ${stats.messages} 条 · 事实 ${stats.facts} 条（读不到数据库文件体积）`,
      ''));
  } else {
    const mb = dbBytes / 1024 ** 2;
    const score = mb < 200 ? 1 : mb < 500 ? 0.8 : mb < 1024 ? 0.5 : 0.2;
    const status: HealthStatus = mb < 200 ? 'ok' : mb < 500 ? 'warn' : 'error';
    checks.push(check('storage', '数据库', 10, score, status,
      `brain.db ${fmtBytes(dbBytes)}（WAL ${fmtBytes(walBytes)}）· 消息 ${stats.messages.toLocaleString()} 条 · 事实 ${stats.facts.toLocaleString()} 条`,
      status === 'ok' ? '' : '定期执行数据库维护（清理过期摘要与低置信度事实）可以控制体积增长'));
  }

  // 6) 记忆索引（10）
  if (stats.facts === 0) {
    checks.push(check('memory', '记忆索引', 10, 1, 'ok', '还没有长期事实，无需向量索引', ''));
  } else if (embeddingCoverage != null && embeddingCoverage >= 0.9) {
    checks.push(check('memory', '记忆索引', 10, 1, 'ok',
      `${embedding.total}/${stats.facts} 条事实有向量（${(embeddingCoverage * 100).toFixed(0)}%）`,
      ''));
  } else if (embeddingCoverage != null && embeddingCoverage > 0) {
    checks.push(check('memory', '记忆索引', 10, 0.8, 'warn',
      `${embedding.total}/${stats.facts} 条事实有向量（${(embeddingCoverage * 100).toFixed(0)}%）`,
      '部分事实还没有向量，语义召回会漏；重新索引一次即可补齐'));
  } else {
    checks.push(check('memory', '记忆索引', 10, 0.4, 'warn',
      `${stats.facts} 条事实都没有向量`,
      '语义召回已退化为关键词匹配；到「模型接入 → 用途模型」配置 embedding 模型后重建索引'));
  }

  const totalWeight = checks.reduce((n, c) => n + c.weight, 0);
  const score = Math.round((checks.reduce((n, c) => n + c.weight * c.score, 0) / totalWeight) * 100);
  const grade: HealthStatus = score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'error';
  const gradeLabel = grade === 'ok' ? '健康' : grade === 'warn' ? '需要关注' : '存在故障';
  const issues = checks.filter((c) => c.status === 'error' || c.status === 'warn');
  const summary = issues.length === 0
    ? '各项检查通过，连接、模型、投递、存储都正常'
    : `${issues.length} 项需要处理：${issues.map((c) => c.label).join('、')}`;

  // ---------- 最近失败（模型 / 任务 / 投递合并） ----------
  // 每类各取最近 4 条再按时间排序：模型失败往往一次刷屏十几条，
  // 直接混排会把偶发的任务/投递失败挤出视野，而那两类才最需要人处理。
  const FAIL_PER_KIND = 4;
  const failures: HealthFailure[] = [];
  for (const r of failureRows.slice(0, FAIL_PER_KIND)) {
    const retry = num(r.retry);
    const latency = num(r.latency_ms);
    failures.push({
      at: num(r.created_at),
      kind: 'model',
      title: `${str(r.provider)}/${str(r.model) || '未指定模型'} 调用失败`,
      detail: [
        `用途 ${str(r.purpose)}`,
        `耗时 ${latency} ms`,
        retry > 0 ? `第 ${retry + 1} 次尝试` : '',
        str(r.error),
      ].filter(Boolean).join(' · '),
    });
  }
  for (const r of tasks.recentRuns.slice(0, FAIL_PER_KIND)) {
    failures.push({
      at: r.at,
      kind: 'task',
      title: `定时任务 ${r.taskId} ${r.status === 'unknown' ? '投递结果未知' : '投递失败'}`,
      detail: r.error || '（没有记录原因）',
    });
  }
  const deliveryFailRows = rows(
    db,
    `SELECT scope, state, created_at FROM reply_deliveries
      WHERE created_at >= ? AND state IN ('failed','partial','unknown')
      ORDER BY created_at DESC LIMIT ${FAIL_PER_KIND}`,
    since,
  );
  for (const r of deliveryFailRows) {
    const state = str(r.state);
    failures.push({
      at: num(r.created_at),
      kind: 'delivery',
      title: `回复投递${state === 'partial' ? '部分成功' : state === 'unknown' ? '结果未知' : '失败'}`,
      detail: `会话 ${str(r.scope)}`,
    });
  }
  failures.sort((a, b) => b.at - a.at);

  return {
    ok: true,
    generatedAt: now,
    windowMs: HEALTH_WINDOW_MS,
    score,
    grade,
    gradeLabel,
    summary,
    checks,
    models,
    trend,
    failures: failures.slice(0, 12),
    tasks,
    delivery,
    storage,
  };
}
