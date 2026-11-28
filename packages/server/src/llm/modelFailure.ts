import { APICallError } from 'ai'

// Responses can emit an API error as a plain SSE envelope even after HTTP 200.
function streamError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('type' in error) || error.type !== 'error') return undefined
  return error as { status?: number; code?: string; error?: { code?: string } }
}
export function upstreamStatus(error: unknown) {
  return APICallError.isInstance(error) ? error.statusCode : streamError(error)?.status
}
export function upstreamCode(error: unknown) {
  return APICallError.isInstance(error) ? (error.data as { error?: { code?: string } } | undefined)?.error?.code
    : streamError(error)?.error?.code ?? streamError(error)?.code
}

const STRUCTURED_ERROR_NAMES = new Set([
  'AI_NoObjectGeneratedError',
  'AI_JSONParseError',
  'AI_TypeValidationError',
  'AI_NoContentGeneratedError',
])

export function isStructuredOutputError(error: unknown): boolean {
  return error instanceof Error && STRUCTURED_ERROR_NAMES.has(error.name)
}

function errorFinishReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('finishReason' in error)) return undefined
  return typeof error.finishReason === 'string' ? error.finishReason : undefined
}

function zodFailurePaths(error: unknown): string[] {
  const paths: string[] = []
  const visited = new Set<unknown>()
  let cur: unknown = error
  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur)
    const cause = 'cause' in cur ? (cur as { cause?: unknown }).cause : undefined
    if (cause && typeof cause === 'object' && 'issues' in cause && Array.isArray((cause as { issues?: unknown[] }).issues)) {
      for (const issue of (cause as { issues: Array<{ path?: unknown[]; code?: string }> }).issues.slice(0, 6)) {
        const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
        paths.push(`${path || '<root>'}:${issue.code ?? 'invalid'}`)
      }
      break
    }
    cur = cause
  }
  return paths
}

// Extract only non-sensitive metadata for local diagnostics; never log diary text or secrets.
export function safeErrorMeta(
  error: unknown,
  context: { stage: 'read' | 'merge'; transport: string; publishedItems?: number; publishedSummary?: boolean },
) {
  const errName = error instanceof Error ? error.name : typeof error
  const causeName = error instanceof Error && error.cause instanceof Error ? error.cause.name : undefined
  const status = upstreamStatus(error)
  const code = upstreamCode(error)
  const finishReason = errorFinishReason(error)
  const zodPaths = zodFailurePaths(error)
  return {
    ...context,
    errorName: errName,
    ...(causeName && { causeName }),
    ...(status !== undefined && { status }),
    ...(code && { code }),
    ...(finishReason && { finishReason }),
    ...(zodPaths.length && { zodPaths }),
  }
}

export function logDiaryDiagnostic(
  context: { stage: 'read' | 'merge'; transport: string; publishedItems?: number; publishedSummary?: boolean; outcome: 'fallback' | 'failed' },
  error: unknown,
) {
  console.warn('[diary-analysis]', JSON.stringify(safeErrorMeta(error, context)))
}

// Provider errors may include request data. Map safe codes, never forward error bodies.
export function modelFailure(error: unknown) {
  const status = upstreamStatus(error), code = upstreamCode(error)
  if (status === 401 || code === 'invalid_api_key') return { status: 502, message: '生成接口拒绝了本次请求（401）。请在「设置 → 对话与分析模型」测试连接，核对 API 地址、密钥和模型权限；能列出模型不代表能调用模型。' } as const
  if (status === 403) return { status: 502, message: '模型接口不允许本次调用（403）。请检查密钥的模型使用权限和所选模型。' } as const
  if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota') return { status: 502, message: '模型接口触发限流或额度不足（429）。请检查服务商额度，稍后再试。' } as const
  if (status === 404 || code === 'model_not_found') return { status: 502, message: '模型接口找不到请求的路径或模型（404）。请核对 API 地址和模型名称。' } as const
  if (code === 'invalid_json_schema') return { status: 502, message: '模型接口拒绝了分析所需的输出结构。请重试；如果仍出现，请换一个支持结构化输出的模型。' } as const
  if (error instanceof Error) {
    if (error.message === '请先在设置中配置模型。') return { status: 502, message: error.message } as const
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return { status: 504, message: '等待模型分析超时，请稍后继续。' } as const
    if (isStructuredOutputError(error)) {
      const finishReason = errorFinishReason(error)
      const causeName = error.cause instanceof Error ? error.cause.name : undefined
      if (finishReason === 'length') {
        return { status: 502, message: '模型输出因长度限制被截断，未能完成结构化结果。请重试，或在设置中改用输出上限更大的模型。' } as const
      }
      if (error.name === 'AI_JSONParseError' || causeName === 'AI_JSONParseError') {
        return { status: 502, message: '模型返回的 JSON 格式不完整或无法解析。请重试，或在设置中改用支持结构化输出的模型。' } as const
      }
      if (error.name === 'AI_TypeValidationError' || causeName === 'AI_TypeValidationError') {
        return { status: 502, message: '模型返回了结果，但字段格式不符合分析要求。请重试，或在设置中改用支持结构化输出的模型。' } as const
      }
      return { status: 502, message: '模型没有返回可读取的结构化结果。请重试，或在设置中改用支持结构化输出的模型。' } as const
    }
  }
  return undefined
}
