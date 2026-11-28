import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { generateText } from 'ai'
import { modelFailure } from '../llm/modelFailure.js'
import { getLLM } from '../llm/provider.js'
import { keyForEndpoint, normalizeEndpoint, saveLocalAI } from '../personal/localAI.js'
import { beginMaintenance } from '../personal/maintenance.js'
import { EMBEDDING_MODEL, localEmbeddings } from '../personal/search.js'
import { createBackup, InvalidBackup, listBackups, readBackup, replaceRecords } from '../personal/localBackup.js'
import type { AppVariables } from '../types.js'

export const localSettingsRoute = new Hono<{ Variables: AppVariables }>()
localSettingsRoute.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
localSettingsRoute.use('*', bodyLimit({ maxSize: 16_384, onError: c => c.json({ error: '设置请求过大。' }, 413) }))
localSettingsRoute.use('*', async (c, next) => {
  if (c.req.method === 'POST' && c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return c.json({ error: '请从成我设置页提交此操作。' }, 415)
  }
  await next()
})

const endpoint = z.string().trim().min(1).max(2048).transform((value, ctx) => {
  try { return normalizeEndpoint(value) }
  catch { ctx.addIssue({ code: 'custom', message: 'API 地址需要 HTTPS；本机服务可以用 HTTP。' }); return z.NEVER }
})
const apiInput = z.object({ apiBaseUrl: endpoint, apiKey: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/).optional() })
const modelInput = apiInput.extend({ model: z.string().trim().min(1).max(250).regex(/^[^\p{Cc}]+$/u) })
const readJson = (req: Request) => req.json().catch(() => null)
const unavailable = { error: '还有聊天、分析或其他操作在进行，请等结束后再试。' }
const checkConfig = () => ({ apiBaseUrl: process.env.OPENAI_BASE_URL ?? '', model: process.env.LLM_MODEL ?? '',
  keyConfigured: Boolean(process.env.OPENAI_API_KEY), embeddingModel: EMBEDDING_MODEL,
  embeddingsEnabled: process.env.BECOMING_ME_EMBEDDINGS !== '0' })

localSettingsRoute.get('/', c => c.json(checkConfig()))
localSettingsRoute.post('/ai', async c => {
  const result = modelInput.safeParse(await readJson(c.req.raw))
  if (!result.success) return c.json({ error: '请检查 API 地址、密钥格式和模型名称。' }, 400)
  const { apiBaseUrl, apiKey, model } = result.data
  const release = beginMaintenance()
  if (!release) return c.json(unavailable, 409)
  try {
    const key = keyForEndpoint(apiBaseUrl, apiKey)
    if (!key && new URL(apiBaseUrl).protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiBaseUrl).hostname)) {
      return c.json({ error: '请为该 API 地址填写密钥。更换地址时不会沿用旧密钥。' }, 400)
    }
    await saveLocalAI(apiBaseUrl, model, key)
    return c.json(checkConfig())
  } catch { return c.json({ error: '未能保存本机模型设置，原配置未更改。' }, 500) }
  finally { release() }
})

localSettingsRoute.post('/models', async c => {
  const result = apiInput.safeParse(await readJson(c.req.raw))
  if (!result.success) return c.json({ error: '请先填写有效的 API 地址和密钥。' }, 400)
  const { apiBaseUrl, apiKey } = result.data
  try {
    const key = keyForEndpoint(apiBaseUrl, apiKey)
    const res = await fetch(`${apiBaseUrl}/models`, { headers: { Accept: 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
      redirect: 'error', signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]) })
    if (!res.ok) {
      await res.body?.cancel()
      return c.json({ error: res.status === 401 || res.status === 403 ? '接口没有授权读取模型列表，请检查密钥；也可以手动输入模型名称。' : '接口没有提供可用的模型列表，可以手动输入模型名称。' }, 502)
    }
    const payload = z.object({ data: z.array(z.object({ id: z.string().trim().min(1).max(250).regex(/^[^\p{Cc}]+$/u) })) }).safeParse(await res.json())
    if (!payload.success || !payload.data.data.length) return c.json({ error: '接口没有返回可选择的模型，可以手动输入模型名称。' }, 502)
    return c.json({ models: [...new Set(payload.data.data.map(model => model.id))].sort((a, b) => a.localeCompare(b)) })
  } catch { return c.json({ error: '无法读取模型列表，请检查 API 地址，也可以手动输入模型名称。' }, 502) }
})

localSettingsRoute.post('/check', async c => {
  const target = z.object({ target: z.enum(['chat', 'embedding']) }).safeParse(await readJson(c.req.raw))
  if (!target.success) return c.json({ error: '未知的连接检查类型。' }, 400)
  const embedding = target.data.target === 'embedding'
  if (embedding && process.env.BECOMING_ME_EMBEDDINGS === '0') return c.json({ state: 'disabled' })
  const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(embedding ? 12_000 : 35_000)])
  try {
    if (embedding) await localEmbeddings(['成我：虚构的本地向量连通性测试。'], signal)
    else {
      if (!process.env.LLM_MODEL || !process.env.OPENAI_BASE_URL) return c.json({ state: 'disabled' })
      const { text } = await generateText({ model: getLLM(), prompt: '这是一条虚构的连通性测试。请只回复：连接正常。', abortSignal: signal, maxRetries: 0 })
      if (!text.trim()) return c.json({ state: 'unavailable' })
    }
    return c.json({ state: 'ready' })
  } catch (error) {
    const failure = embedding ? undefined : modelFailure(error)
    return failure ? c.json({ error: failure.message }, failure.status) : c.json({ state: 'unavailable' })
  }
})

localSettingsRoute.get('/backups', async c => {
  try { return c.json(await listBackups()) }
  catch { return c.json({ error: '暂时无法读取本地备份目录。' }, 500) }
})
localSettingsRoute.post('/backups', async c => {
  const release = beginMaintenance()
  if (!release) return c.json(unavailable, 409)
  try { return c.json({ backup: await createBackup(c.get('db'), c.get('userId'), 'manual') }, 201) }
  catch { return c.json({ error: '备份失败，请检查本地磁盘空间和目录权限。' }, 500) }
  finally { release() }
})
localSettingsRoute.post('/restore', async c => {
  const result = z.object({ name: z.string().max(160) }).safeParse(await readJson(c.req.raw))
  if (!result.success) return c.json({ error: '请选择要恢复的备份。' }, 400)
  const release = beginMaintenance()
  if (!release) return c.json(unavailable, 409)
  try {
    const db = c.get('db'), user = c.get('userId')
    const snapshot = await readBackup(result.data.name, user)
    const before = await createBackup(db, user, 'before-restore')
    await replaceRecords(db, user, snapshot)
    clearTicket = undefined
    return c.json({ backup: before })
  } catch (e) {
    if (e instanceof InvalidBackup) return c.json({ error: e.message }, 400)
    return c.json({ error: '恢复未完成，现有记录未更改。请检查备份、磁盘空间和目录权限。' }, 500)
  } finally { release() }
})

const clearDelay = 5000
let clearTicket: { token: string; user: string; issued: number } | undefined
localSettingsRoute.post('/clear/prepare', c => {
  clearTicket = { token: randomUUID(), user: c.get('userId'), issued: performance.now() }
  return c.json({ token: clearTicket.token, delayMs: clearDelay })
})
localSettingsRoute.post('/clear', async c => {
  const result = z.object({ token: z.string().uuid() }).safeParse(await readJson(c.req.raw))
  const ticket = clearTicket, user = c.get('userId'), elapsed = performance.now() - (ticket?.issued ?? 0)
  if (!result.success || !ticket || ticket.token !== result.data.token || ticket.user !== user || elapsed > 300_000) {
    return c.json({ error: '清除确认已过期，请取消后重新发起。' }, 400)
  }
  if (elapsed < clearDelay) return c.json({ error: '请等 5 秒后再确认删除。' }, 409)
  const release = beginMaintenance()
  if (!release) return c.json(unavailable, 409)
  try {
    const db = c.get('db')
    const backup = await createBackup(db, user, 'before-clear')
    await replaceRecords(db, user)
    clearTicket = undefined
    return c.json({ backup })
  } catch { return c.json({ error: '清除未完成，现有记录未更改。请检查本地备份目录和磁盘空间。' }, 500) }
  finally { release() }
})
