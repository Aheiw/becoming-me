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
    if (['AI_NoObjectGeneratedError', 'AI_JSONParseError', 'AI_TypeValidationError', 'AI_NoContentGeneratedError'].includes(error.name)) {
      return { status: 502, message: '模型没有返回可读取的结构化结果。请重试，或在设置中改用支持结构化输出的模型。' } as const
    }
  }
  return undefined
}
