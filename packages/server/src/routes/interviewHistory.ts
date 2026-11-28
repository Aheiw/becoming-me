import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { interviewDiaryBatches, rawLogs, sessions } from '../db/schema.js'
import { citationsMatch, diaryAnalysisItemSchema, diaryEntriesSchema, MAX_SUGGESTIONS } from '../llm/diarySchemas.js'
import { removeDiaryBatch } from '../personal/diaryDeletion.js'
import type { AppVariables } from '../types.js'

const batchSchema = z.object({
  entries: diaryEntriesSchema,
  analysis: z.array(diaryAnalysisItemSchema).max(MAX_SUGGESTIONS),
})
const batches = interviewDiaryBatches
const owned = (id: string, userId: string) => and(eq(batches.id, id), eq(batches.userId, userId))
export const interviewHistoryRoute = new Hono<{ Variables: AppVariables }>()

interviewHistoryRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
interviewHistoryRoute.onError((_, c) => c.json({ error: '本地访谈历史暂时无法访问，请重试。' }, 500))

interviewHistoryRoute.get('/', async c => {
  const db = c.get('db')
  const userId = c.get('userId')
  const [history, diaries] = await Promise.all([
    db.select({ id: sessions.id, type: sessions.type, status: sessions.status, startedAt: sessions.createdAt })
      .from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt), desc(sessions.id)),
    db.select({ id: batches.id, createdAt: batches.createdAt, origin: batches.origin, count: sql<number>`jsonb_array_length(${batches.entries})`,
      filename: sql<string | null>`${batches.entries}->0->>'filename'`, hasAnalysis: sql<boolean>`${batches.analysis} IS NOT NULL` })
      .from(batches).where(eq(batches.userId, userId)).orderBy(desc(batches.createdAt), desc(batches.id)),
  ])
  return c.json({ sessions: history, diaries })
})

// Only dates, counts and pointers are sent to the calendar. The body is fetched separately on demand.
interviewHistoryRoute.get('/diary-calendar', async c => {
  const month = c.req.query('month')
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: '请选择有效月份。' }, 400)
  const whitespace = '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
  const entries = await c.get('db').execute<{ date: string; batchId: string; index: number; filename: string | null; characters: number }>(sql`
    SELECT entry.payload->>'date' AS date, batch.id AS "batchId", (entry.ordinal - 1)::integer AS index,
      entry.payload->>'filename' AS filename,
      char_length(regexp_replace(entry.payload->>'content', ${whitespace}, '', 'g')) AS characters
    FROM ${batches} AS batch
    CROSS JOIN LATERAL jsonb_array_elements(batch.entries) WITH ORDINALITY AS entry(payload, ordinal)
    WHERE batch.user_id = ${c.get('userId')} AND entry.payload->>'date' LIKE ${month + '-%'}
    ORDER BY date, batch.created_at, batch.id, entry.ordinal
  `)
  return c.json({ entries: [...entries] })
})

interviewHistoryRoute.get('/sessions/:id', async c => {
  const db = c.get('db')
  const userId = c.get('userId')
  const id = c.req.param('id')
  const [session] = await db.select({ status: sessions.status, type: sessions.type }).from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
  if (!session) return c.json({ error: '找不到这轮访谈。' }, 404)
  const rows = await db.select({ role: rawLogs.role, content: rawLogs.content }).from(rawLogs)
    .where(and(eq(rawLogs.sessionId, id), eq(rawLogs.userId, userId), inArray(rawLogs.role, ['user', 'assistant'])))
    .orderBy(asc(rawLogs.createdAt), asc(rawLogs.id))
  return c.json({ id, ...session, messages: rows })
})

interviewHistoryRoute.post('/diaries', async c => {
  const batch = batchSchema.safeParse(await c.req.json().catch(() => null))
  if (!batch.success) return c.json({ error: '请先完成综合分析，再带入访谈。' }, 400)
  const userId = c.get('userId')
  const { entries, analysis } = batch.data
  if (analysis.some(item => !citationsMatch(entries, item))) {
    return c.json({ error: '分析里的引文与日记原文不符，请重新分析。' }, 400)
  }
  const id = createHash('sha256').update(JSON.stringify([userId, entries])).digest('hex')
  await c.get('db').insert(batches).values({ id, userId, entries, analysis, origin: 'import' })
    .onConflictDoUpdate({ target: batches.id, set: { analysis }, setWhere: eq(batches.userId, userId) })
  return c.json({ id, count: entries.length }, 201)
})

interviewHistoryRoute.get('/diaries/:id', async c => {
  const [batch] = await c.get('db').select({ entries: batches.entries, analysis: batches.analysis }).from(batches)
    .where(owned(c.req.param('id'), c.get('userId')))
  return batch ? c.json({ ...batch, analysis: batch.analysis?.filter(item => !item.profileDraft) ?? null }) : c.json({ error: '找不到这批日记。' }, 404)
})

interviewHistoryRoute.delete('/diaries/:id', async c => {
  const id = c.req.param('id'), userId = c.get('userId')
  const deleted = await removeDiaryBatch(c.get('db'), userId, id)
  return deleted ? c.body(null, 204) : c.json({ error: '找不到这批日记。' }, 404)
})
