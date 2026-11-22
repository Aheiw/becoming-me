import { APICallError } from 'ai'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { diaryEntries, diaryFactEvidences, diarySavedBatches, structuredFacts } from '../db/schema.js'
import { analyzeDiaries } from '../llm/diary.js'
import { citationsMatch, diaryEntriesSchema, diarySuggestionSchema, MAX_SUGGESTIONS, uniqueCitations } from '../llm/diarySchemas.js'
import { docForModel } from '../personal/model.js'
import { memoryDocs, searchMemory } from '../personal/search.js'
import { importHistoricalAnalysis, storeDiaryAnalysis } from '../personal/store.js'
import type { AppVariables } from '../types.js'

const batchSchema = z.object({ entries: diaryEntriesSchema })
const saveSchema = batchSchema.extend({
  id: z.string().uuid(),
  suggestions: z.array(diarySuggestionSchema).min(1).max(MAX_SUGGESTIONS),
})

export const diaryRoute = new Hono<{ Variables: AppVariables }>()

diaryRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

function analysisFailure(error: unknown) {
  if (APICallError.isInstance(error)) {
    const code = (error.data as { error?: { code?: string } } | undefined)?.error?.code
    if (error.statusCode === 413 || code === 'context_length_exceeded' ||
        /context_length_exceeded|maximum context length|context window|input is too long/i.test(error.message)) {
      return { status: 413, message: '这次的日记超过了模型 API 单次能读的量。没有自动拆分、截断或写入；可减少本次选择的日记后再试。' } as const
    }
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { status: 504, message: '等待模型分析超时，没有写入任何内容。请重试。' } as const
  }
  return { status: 502, message: '模型没有完成日记分析，请稍后重试。没有写入任何内容。' } as const
}

diaryRoute.post('/analyze', async (c) => {
  const batch = batchSchema.safeParse(await c.req.json().catch(() => null))
  if (!batch.success) return c.json({ error: '请至少导入一份非空日记；日期无法识别时可以留空。' }, 400)
  const { entries } = batch.data
  const saveToWorkspace = c.req.query('workspace') === '1'
  const recall = async (signal: AbortSignal) => {
    if (!saveToWorkspace) return []
    const db = c.get('db'), userId = c.get('userId')
    const state = await importHistoricalAnalysis(db, userId)
    const docs = await memoryDocs(db, userId, state)
    const step = Math.max(1, Math.ceil(entries.length / 12))
    const query = entries.filter((_, i) => i % step === 0).map(e => e.content.trim().slice(0, 140)).join('\n')
    return (await searchMemory(db, userId, docs, query, signal)).hits.slice(0, 5).map(docForModel)
  }
  const persist = (suggestions: Awaited<ReturnType<typeof analyzeDiaries>>) => saveToWorkspace
    ? storeDiaryAnalysis(c.get('db'), c.get('userId'), entries, suggestions) : Promise.resolve(randomUUID())

  if (c.req.header('accept')?.includes('application/x-ndjson')) {
    c.header('Content-Type', 'application/x-ndjson; charset=UTF-8')
    return stream(c, async output => {
      const controller = new AbortController()
      output.onAbort(() => controller.abort())
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
      try {
        await output.writeln(JSON.stringify({ type: 'progress', phase: 'analyze' }))
        const suggestions = (await analyzeDiaries(entries, {
          signal, workspace: saveToWorkspace, related: await recall(signal),
          onSummary: async delta => {
            if (!signal.aborted) await output.writeln(JSON.stringify({ type: 'summary', delta }))
          },
          onItem: async item => {
            if (!signal.aborted && citationsMatch(entries, item)) await output.writeln(JSON.stringify({ type: 'item', item }))
          },
        })).filter(item => citationsMatch(entries, item))
        if (!signal.aborted) {
          const id = await persist(suggestions)
          await output.writeln(JSON.stringify({ type: 'result', id, suggestions }))
        }
      } catch (error) {
        // Provider errors can include diary text; never expose or log them.
        if (!signal.aborted) await output.writeln(JSON.stringify({ type: 'error', error: analysisFailure(error).message }))
      }
    })
  }

  try {
    const suggestions = (await analyzeDiaries(entries, { workspace: saveToWorkspace, related: await recall(c.req.raw.signal) })).filter(item => citationsMatch(entries, item))
    return c.json({ id: await persist(suggestions), suggestions })
  } catch (error) {
    const failure = analysisFailure(error)
    return c.json({ error: failure.message }, failure.status)
  }
})

diaryRoute.post('/save', async (c) => {
  const batch = saveSchema.safeParse(await c.req.json().catch(() => null))
  if (!batch.success) return c.json({ error: '请核对日记，并至少选择一条建议。' }, 400)
  const { entries, id, suggestions } = batch.data
  if (suggestions.some(item => !citationsMatch(entries, item))) {
    return c.json({ error: '至少一条引文和对应日记的原文不符，请重新分析。' }, 400)
  }
  const userId = c.get('userId')
  try {
    const saved = await c.get('db').transaction(async (tx) => {
      const inserted = await tx.insert(diarySavedBatches)
        .values({ id, userId }).onConflictDoNothing().returning({ id: diarySavedBatches.id })
      if (!inserted.length) return false
      const diaryIds = new Map([...new Set(suggestions.flatMap(item => item.citations.map(citation => citation.source)))].map(source => [source, randomUUID()]))
      await tx.insert(diaryEntries).values([...diaryIds].map(([source, diaryId]) => {
        const entry = entries[source - 1]
        return { id: diaryId, userId, entryDate: entry.date, filename: entry.filename, content: entry.content }
      }))
      const facts = suggestions.map(item => ({ ...item, id: randomUUID() }))
      await tx.insert(structuredFacts).values(facts.map(({ id, category, fact }) => ({
        id, userId, category, fact, source: 'diary' as const, visibility: 'private' as const,
      })))
      await tx.insert(diaryFactEvidences).values(facts.flatMap(({ id: factId, citations }) =>
        uniqueCitations(citations).map(({ source, quote }, ordinal) => ({ factId, ordinal, diaryId: diaryIds.get(source)!, quote })),
      ))
      return true
    })
    if (!saved) return c.json({ error: '这批建议已写入过，请在「关于我」中查看。' }, 409)
    return c.json({ saved: suggestions.length }, 201)
  } catch {
    return c.json({ error: '保存失败，请重试。' }, 500)
  }
})

diaryRoute.get('/:id', async (c) => {
  const [entry] = await c.get('db').select({ date: diaryEntries.entryDate, content: diaryEntries.content })
    .from(diaryEntries).where(and(eq(diaryEntries.id, c.req.param('id')), eq(diaryEntries.userId, c.get('userId'))))
  return entry ? c.json(entry) : c.json({ error: '找不到这篇日记。' }, 404)
})
