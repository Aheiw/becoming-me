import { profileContext } from '../personal/profile.js'
import { trackLocalRequest } from '../personal/maintenance.js'
import { APICallError } from 'ai'
import { modelFailure, upstreamCode, upstreamStatus } from '../llm/modelFailure.js'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { diaryEntries, diaryFactEvidences, diarySavedBatches, interviewDiaryBatches, structuredFacts } from '../db/schema.js'
import { analyzeDiaries, mergeDiaryFindings } from '../llm/diary.js'
import { citationsMatch, diaryEntriesSchema, diarySuggestionSchema, MAX_SUGGESTIONS, uniqueCitations } from '../llm/diarySchemas.js'
import { correctionsForModel, docForModel } from '../personal/model.js'
import { memoryDocs, searchMemory } from '../personal/search.js'
import { archiveDiaries, changeState, getState, importHistoricalAnalysis, storeDiaryAnalysis } from '../personal/store.js'
import { runDiaryBatch, type AnalysisProgress } from '../llm/diaryBatch.js'
import type { AppVariables } from '../types.js'

const batchSchema = z.object({ entries: diaryEntriesSchema })
const workspaceInput = z.union([batchSchema, z.object({ batchId: z.string().min(1).max(128) })])
const activeRuns = new Set<string>()
const saveSchema = batchSchema.extend({
  id: z.string().uuid(),
  suggestions: z.array(diarySuggestionSchema).min(1).max(MAX_SUGGESTIONS),
})

export const diaryRoute = new Hono<{ Variables: AppVariables }>()

diaryRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

function analysisFailure(error: unknown, archived = false) {
  const retry = '日记原件和已完成的进度已保留，可以到「日记资料库」继续，不会覆盖现有百科。'
  if (upstreamStatus(error) === 413 || upstreamCode(error) === 'context_length_exceeded' ||
      (APICallError.isInstance(error) && /context_length_exceeded|maximum context length|context window|input is too long/i.test(error.message))) {
    return { status: 413, message: archived ? '模型 API 的上下文容量不足以读取这一段。' + retry : '这次的日记超过了模型 API 单次能读的量。没有自动拆分、截断或写入；可减少本次选择的日记后再试。' } as const
  }
  const known = modelFailure(error)
  if (known && known.status !== 504) return { status: known.status, message: known.message + (archived ? retry : '') } as const
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { status: 504, message: archived ? '等待模型分析超时。' + retry : '等待模型分析超时，没有写入任何内容。请重试。' } as const
  }
  return { status: 502, message: archived ? '这一步分析没有完成。' + retry : '模型没有完成日记分析，请稍后重试。没有写入任何内容。' } as const
}

diaryRoute.post('/analyze', async (c) => {
  const workspace = c.req.query('workspace') === '1'
  const batch = (workspace ? workspaceInput : batchSchema).safeParse(await c.req.json().catch(() => null))
  if (!batch.success) return c.json({ error: '请导入非空日记，或选择本地已经保存的一批。' }, 400)
  const db = c.get('db'), userId = c.get('userId')
  const supplied = 'entries' in batch.data ? batch.data.entries : undefined
  let id: string, entries = supplied ?? [], existing: Awaited<ReturnType<typeof analyzeDiaries>> | null = null
  if (workspace) {
    try {
      id = 'batchId' in batch.data ? batch.data.batchId : await archiveDiaries(db, userId, entries)
      const table = interviewDiaryBatches
      const [row] = await db.select({ entries: table.entries, analysis: table.analysis }).from(table).where(and(eq(table.id, id), eq(table.userId, userId)))
      if (!row) return c.json({ error: '找不到这批日记。' }, 404)
      entries = row.entries; existing = row.analysis
    } catch { return c.json({ error: '暂时无法打开日记资料库。' }, 500) }
  } else { id = randomUUID() }

  const runKey = JSON.stringify([userId, id])
  if (workspace && activeRuns.has(runKey)) return c.json({ error: '这批日记正在分析，请等原任务结束后再继续。' }, 409)
  if (workspace) activeRuns.add(runKey)
  const run = async (signal: AbortSignal, output?: (event: object) => Promise<void>) => {
    const onSummary = output && ((delta: string) => output({ type: 'summary', delta }))
    const onItem = output && (async (item: Awaited<ReturnType<typeof analyzeDiaries>>[number]) => {
      if (!item.profileDraft && citationsMatch(entries, item)) await output({ type: 'item', item })
    })
    if (!workspace) {
      const result = await (output ? analyzeDiaries(entries, { signal, onSummary, onItem }) : analyzeDiaries(entries))
      return { suggestions: result.filter(item => !item.profileDraft && citationsMatch(entries, item)), profileChanged: 0 }
    }
    if (existing) return { suggestions: existing.filter(item => !item.profileDraft && citationsMatch(entries, item)), profileChanged: 0 }
    const state = await importHistoricalAnalysis(db, userId)
    const docs = await memoryDocs(db, userId, state)
    const stride = Math.max(1, Math.ceil(entries.length / 12))
    const query = entries.filter((_, i) => i % stride === 0).map(e => e.content.trim().slice(0, 140)).join('\n')
    const profile = profileContext(state, undefined, query)
    const related = (await searchMemory(db, userId, docs, query, signal)).hits.slice(0, 5).map(docForModel)
    const articleIndex = [...new Map([...related.filter(d => d.kind === 'article'), ...docs.filter(d => d.kind === 'article')].map(d => [d.sourceId, d])).values()]
      .slice(0, 60).map(d => ({ id: d.sourceId, title: d.title }))
    const checkpoints = (await getState(db, userId)).diaryJobs?.[id] ?? {}
    const suggestions = await runDiaryBatch(entries, {
      signal, checkpoints,
      read: segment => analyzeDiaries(segment, { signal, workspace: true, related, articleIndex, corrections: correctionsForModel(state, query), profile, onSummary }),
      merge: (candidates) => mergeDiaryFindings(candidates, signal),
      progress: async (progress: AnalysisProgress) => { await output?.({ type: 'progress', ...progress }) },
      save: async (key, items) => { await changeState(db, userId, async (fresh, tx) => {
        const table = interviewDiaryBatches
        const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.userId, userId)))
        if (!row) throw new Error('The archived batch was removed.')
        const job = (fresh.diaryJobs ??= {})[id] ??= {}
        job[key] = items
      }) },
    })
    signal.throwIfAborted()
    return storeDiaryAnalysis(db, userId, id, suggestions.filter(item => citationsMatch(entries, item)), profile)
  }
  if (c.req.header('accept')?.includes('application/x-ndjson')) {
    c.header('Content-Type', 'application/x-ndjson; charset=UTF-8')
    return stream(c, async output => {
      const finishWork = trackLocalRequest()
      const controller = new AbortController()
      output.onAbort(() => controller.abort())
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
      const emit = async (event: object) => { if (!signal.aborted) await output.writeln(JSON.stringify(event)) }
      try {
        await emit({ type: 'progress', phase: 'analyze', ...(workspace && { batchId: id }) })
        await emit({ type: 'result', id, ...await run(signal, emit) })
      } catch (error) {
        // Provider errors can include diary text; never expose or log them.
        await emit({ type: 'error', error: analysisFailure(error, workspace).message })
      } finally { activeRuns.delete(runKey); finishWork() }
    })
  }
  try {
    return c.json({ id, ...await run(c.req.raw.signal) })
  } catch (error) {
    const failure = analysisFailure(error, workspace)
    return c.json({ error: failure.message }, failure.status)
  } finally { activeRuns.delete(runKey) }
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
