/**
 * 模型调用错误分类
 *
 * 面板需要回答的不是「失败了 12 次」，而是「12 次里 9 次限流、2 次余额不足、1 次超时」。
 * 分类优先用 HTTP 状态码（最可靠），拿不到状态码时退回匹配错误文本。
 *
 * 分类只用于诊断展示，不参与重试决策 —— 重试仍然只看 LlmError.retriable。
 */
export type LlmErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'model_missing'
  | 'bad_request'
  | 'context_overflow'
  | 'unsupported'
  | 'server_error'
  | 'cancelled'
  | 'unknown';

export const LLM_ERROR_LABELS: Record<LlmErrorKind, string> = {
  auth: '鉴权失败',
  quota: '额度不足',
  rate_limit: '限流',
  timeout: '超时',
  network: '网络不通',
  model_missing: '模型或地址不存在',
  bad_request: '请求被拒',
  context_overflow: '上下文超限',
  unsupported: '能力不支持',
  server_error: '上游故障',
  cancelled: '主动取消',
  unknown: '未分类',
};

/** 这些类别不算模型的问题：用户打断、进程退出时主动取消 */
export function isIgnorableErrorKind(kind: string): boolean {
  return kind === 'cancelled';
}

export function classifyLlmError(err: unknown): LlmErrorKind {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const status = Number((err as { status?: unknown } | null)?.status);
  const cancelled = Boolean((err as { cancelled?: unknown } | null)?.cancelled);

  // 主动取消优先判定：取消时底层往往也会报「请求超时」，但那不是模型的问题
  if (cancelled || /请求已取消|已中止|aborted|cancell?ed/i.test(message)) return 'cancelled';

  if (Number.isFinite(status) && status > 0) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'quota';
    if (status === 404) return 'model_missing';
    if (status === 429) return 'rate_limit';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500) return 'server_error';
    if (status === 400 || status === 413 || status === 422) {
      return /context|token|too long|maximum/i.test(message) ? 'context_overflow' : 'bad_request';
    }
  }

  if (/超时|timeout|timed out|预算已耗尽/i.test(message)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|fetch failed|无法连接|socket hang up|network/i.test(message))
    return 'network';
  if (/余额|欠费|额度|quota|insufficient|billing/i.test(message)) return 'quota';
  if (/rate.?limit|too many requests|限流/i.test(message)) return 'rate_limit';
  if (/上下文|context.{0,20}(length|window|limit)|too many tokens|maximum context/i.test(message))
    return 'context_overflow';
  if (/不支持(图片|视频|音频|该)|does not support|not support(ed)? (image|vision)/i.test(message))
    return 'unsupported';
  if (/unauthorized|invalid.{0,10}(api.?)?key|鉴权|apikey|api key/i.test(message)) return 'auth';
  if (/not found|不存在|no such model/i.test(message)) return 'model_missing';
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(message)) return 'server_error';
  return 'unknown';
}
