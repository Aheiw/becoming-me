import { APICallError } from 'ai'
import { Hono } from 'hono'
import { processMessage } from '../interview/engine.js'
import { ModelStructuredOutputError } from '../llm/provider.js'
import type { AppVariables } from '../types.js'

export const chatRoute = new Hono<{ Variables: AppVariables }>()
const pendingSessions = new Set<string>()

chatRoute.post('/', async (c) => {
  const body = await c.req.json<{ sessionId: string; message: string; language?: string }>()
  if (!body.sessionId || !body.message?.trim()) {
    return c.json({ error: 'sessionId and message are required' }, 400)
  }
  const local = process.env.PCE_LOCAL === '1'
  const userId = c.get('userId')
  const key = JSON.stringify([userId, body.sessionId])
  if (local && pendingSessions.has(key)) return c.json({ error: '这一轮访谈还有一条消息正在回复，请稍候。' }, 409)
  if (local) pendingSessions.add(key)
  try {
    const { response, shouldEnd, remainingTurns, summary } = await processMessage(
      c.get('db'), body.sessionId, userId, body.message.trim(), body.language,
    )
    return c.json({ response, shouldEnd, remainingTurns, ...(summary && { summary }) })
  } catch (err) {
    if (!local) console.error('[chat] error:', err)
    if (local && APICallError.isInstance(err) && (err.statusCode === 413 ||
      (err.data as { error?: { code?: string } } | undefined)?.error?.code === 'context_length_exceeded' ||
      /context_length_exceeded|maximum context length|context window|input is too long/i.test(err.message))) {
      return c.json({ error: '访谈历史与日记原文合计超过模型单次能读的范围。原文都保留，未做截断；可以在「访谈历史与日记」里移除不需要带入的日记。' }, 413)
    }
    if (err instanceof ModelStructuredOutputError) {
      return c.json({ error: err.message, code: err.code }, 422)
    }
    return c.json({ error: local ? '这次回复未完成，请重试。' : 'Failed to process message' }, 500)
  } finally {
    if (local) pendingSessions.delete(key)
  }
})
