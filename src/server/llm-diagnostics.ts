/**
 * 调用诊断：失败原因分布 + 降级链路
 *
 * 健康中心回答「现在好不好」，这里回答「为什么不好、当时切没切备用模型」。
 *
 * 数据全部来自 llm_calls：一次逻辑调用（invoke）在同一个 chain_id 下记多条尝试，
 * 所以能还原「主模型 429 → 重试 → 切到备用成功」这种链路，而不是只看到散落的失败行。
 *
 * 与 health.ts 一样是只读的，缺列时按变体 SQL 退让，不抛错。
 */
import type { DatabaseSync } from 'node:sqlite';
import { LLM_ERROR_LABELS, type LlmErrorKind } from '../llm/errors.js';

export const DIAG_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ErrorKindStat {
  kind: string;
  label: string;
  count: number;
  /** 占全部失败的比例，0~1 */
  share: number;
}

export interface DegradationStep {
  provider: string;
  model: string;
  ok: boolean;
  errorKind: string;
  error: string;
  at: number;
  latencyMs: number;
}

export interface Degradation {
  chainId: string;
  at: number;
  purpose: string;
  from: string;
  to: string;
  reason: string;
  reasonKind: string;
  reasonLabel: string;
  /** 切换前失败的次数（含重试） */
  attempts: number;
  /** 从第一次尝试到备用成功之间的耗时 */
  elapsedMs: number;
  steps: DegradationStep[];
}

export interface CallDiagnostics {
  ok: true;
  generatedAt: number;
  windowMs: number;
  totals: { calls: number; failed: number; degraded: number };
  errorKinds: ErrorKindStat[];
  degradations: Degradation[];
}

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

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

function label(kind: string): string {
  return LLM_ERROR_LABELS[kind as LlmErrorKind] ?? (kind || '未分类');
}

export function buildCallDiagnostics(db: DatabaseSync, now = Date.now()): CallDiagnostics {
  const since = now - DIAG_WINDOW_MS;

  const totalsRow = rowsAny(
    db,
    [
      `SELECT COUNT(*) AS calls,
              SUM(CASE WHEN success=0 AND error_kind='cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed
         FROM llm_calls WHERE created_at >= ?`,
      `SELECT COUNT(*) AS calls, 0 AS cancelled, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed
         FROM llm_calls WHERE created_at >= ?`,
    ],
    [since],
  )[0];
  const totalCalls = num(totalsRow?.calls);
  const cancelled = num(totalsRow?.cancelled);
  const totalFailed = Math.max(0, num(totalsRow?.failed) - cancelled);

  const kindRows = rowsAny(
    db,
    [
      `SELECT error_kind AS kind, COUNT(*) AS n FROM llm_calls
        WHERE success=0 AND created_at >= ? AND error_kind <> 'cancelled'
        GROUP BY error_kind ORDER BY n DESC`,
      `SELECT 'unknown' AS kind, COUNT(*) AS n FROM llm_calls
        WHERE success=0 AND created_at >= ? GROUP BY 1`,
    ],
    [since],
  );
  const errorKinds: ErrorKindStat[] = kindRows.map((r) => {
    const count = num(r.n);
    return {
      kind: str(r.kind) || 'unknown',
      label: label(str(r.kind)),
      count,
      share: totalFailed > 0 ? count / totalFailed : 0,
    };
  });

  const chainRows = rowsAny(
    db,
    [
      `SELECT chain_id, provider, model, purpose, success, error, error_kind, created_at, latency_ms
         FROM llm_calls WHERE chain_id <> '' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 800`,
    ],
    [since],
  );

  const byChain = new Map<string, Row[]>();
  for (const r of chainRows) {
    const id = str(r.chain_id);
    if (!id) continue;
    const list = byChain.get(id);
    if (list) list.push(r);
    else byChain.set(id, [r]);
  }

  const degradations: Degradation[] = [];
  for (const [chainId, list] of byChain) {
    // 查询是倒序，组内按时间正序还原过程
    const steps = list.slice().sort((a, b) => num(a.created_at) - num(b.created_at));
    const successIndex = steps.findIndex((s) => num(s.success) === 1);
    if (successIndex <= 0) continue; // 没有成功，或一次就成功：都不算降级
    const first = steps[0]!;
    const won = steps[successIndex]!;
    const from = `${str(first.provider)}/${str(first.model) || '-'}`;
    const to = `${str(won.provider)}/${str(won.model) || '-'}`;
    if (from === to) continue; // 同模型重试成功，不是降级

    const failures = steps.slice(0, successIndex).filter((s) => num(s.success) === 0);
    if (failures.length === 0) continue;
    const reasonRow = failures[0]!;
    degradations.push({
      chainId,
      at: num(first.created_at),
      purpose: str(won.purpose) || str(first.purpose),
      from,
      to,
      reason: str(reasonRow.error),
      reasonKind: str(reasonRow.error_kind) || 'unknown',
      reasonLabel: label(str(reasonRow.error_kind)),
      attempts: failures.length,
      elapsedMs: Math.max(0, num(won.created_at) - num(first.created_at)),
      steps: steps.map((s) => ({
        provider: str(s.provider),
        model: str(s.model),
        ok: num(s.success) === 1,
        errorKind: str(s.error_kind),
        error: str(s.error),
        at: num(s.created_at),
        latencyMs: num(s.latency_ms),
      })),
    });
  }
  degradations.sort((a, b) => b.at - a.at);

  return {
    ok: true,
    generatedAt: now,
    windowMs: DIAG_WINDOW_MS,
    totals: { calls: totalCalls, failed: totalFailed, degraded: degradations.length },
    errorKinds,
    degradations: degradations.slice(0, 20),
  };
}
