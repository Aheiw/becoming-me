import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { diaryEntries, interviewDiaryBatches, rawLogs, STRUCTURED_FACT_CATEGORIES } from '../db/schema.js'
import { articleHistory, changeState, combineEvidence, getChat, getState, hash, importHistoricalAnalysis, now, readArticles, saveTurn, WorkspaceError, writeArticle } from '../personal/store.js'
import { memoryDocs, searchMemory } from '../personal/search.js'
import { diaryIntent, isPersonalDream, recallDiary } from '../personal/diaryRecall.js'
import { diaryEntriesSchema } from '../llm/diarySchemas.js'
import { analyzeDream, findGaps, captureTurn, correctionsForModel, docForModel, proposalForModel, reviewEvents, streamConversation, type ModelDraft } from '../personal/model.js'
import type { Article, ComparisonFocus, Evidence, LifeEvent, PersonalState, Proposal } from '../personal/types.js'
import { exportPersonalBook } from '../personal/export.js'
import type { AppVariables } from '../types.js'

const category = z.enum(STRUCTURED_FACT_CATEGORIES)
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !v.includes('\0'))
const optionalText = (max: number) => z.string().trim().max(max).refine(v => !v.includes('\0')).default('')
const key = text(120)
const ids = z.array(key).max(12).default([])
const approximateDate = z.string().refine(value => !value || /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value) || z.string().date().safeParse(value).success).default('')
const comparisonInput = z.object({ eventId: key.optional(), articleId: key.optional() }).refine(v => v.eventId || v.articleId)
const eventInput = z.object({ title: text(600), date: approximateDate, dateNote: optionalText(120), cause: optionalText(3000), outcome: optionalText(4000), facts: text(5000), analysis: optionalText(3000),
  outlook: optionalText(4000), impact: optionalText(4000), prediction: optionalText(3000), chapterId: key.optional(), topics: z.array(text(24)).max(12).optional(), importance: z.enum(['regular', 'milestone', 'turning']).nullable().optional() })
const articleInput = z.object({ title: text(600), category, fact: text(5000), reason: optionalText(500), eventIds: ids })
const actInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('classify'), kind: z.enum(['event', 'article', 'question']) }),
  z.object({ action: z.literal('correct'), correction: text(1500) }),
  z.object({ action: z.literal('event'), target: key.optional(), event: eventInput }),
  z.object({ action: z.literal('article'), target: key.optional(), article: articleInput }),
])

const requireEvent = (state: PersonalState, id: string) => {
  const e = state.events.find(e => e.id === id)
  if (!e) throw new WorkspaceError('找不到这个事件。', 404)
  return e
}
const requireProposal = (state: PersonalState, id: string) => {
  const p = state.proposals.find(p => p.id === id)
  if (!p) throw new WorkspaceError('找不到这条建议。', 404)
  return p
}
async function parse<T>(request: { json: () => Promise<unknown> }, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const result = schema.safeParse(await request.json().catch(() => null))
  if (!result.success) throw new WorkspaceError('有内容未填或格式不正确，请检查后重试。')
  return result.data
}
function updateEvent(state: PersonalState, input: z.infer<typeof eventInput>, id?: string, refs: Evidence[] = []) {
  const existing = id ? requireEvent(state, id) : undefined
  if (input.chapterId && !state.chapters?.some(ch => ch.id === input.chapterId)) throw new WorkspaceError('找不到这个人生章节。', 404)
  const result: LifeEvent = { ...existing, id: existing?.id ?? randomUUID(), ...input, chapterId: input.chapterId, topics: input.topics === undefined ? existing?.topics : [...new Set(input.topics)], importance: input.importance === null ? undefined : input.importance ?? existing?.importance, evidence: combineEvidence(existing?.evidence ?? [], refs), updatedAt: now() }
  if (existing) state.events[state.events.indexOf(existing)] = result
  else state.events.push(result)
  return result
}
function attachEvidence(state: PersonalState, input: z.infer<typeof articleInput>, refs: Evidence[]): Article {
  const eventIds = [...new Set(input.eventIds)]
  return { title: input.title, category: input.category, fact: input.fact, eventIds,
    evidence: eventIds.reduce((all, id) => combineEvidence(all, requireEvent(state, id).evidence), refs) }
}
function addDrafts(state: PersonalState, items: ModelDraft[], opts: { origin: 'chat' | 'review'; logId?: string; chatReplyId?: string; message?: string; diarySources?: Map<string, Evidence>; diaryOnly?: boolean; reviewIds?: string[]; articleId?: string; articleIds: Set<string> }) {
  const created: Proposal[] = []
  const norm = (s: string) => s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  for (const item of items) {
    const eventIds = [...new Set(item.eventIds)].filter(id => state.events.some(e => e.id === id) && (!opts.reviewIds || opts.reviewIds.includes(id)))
    if (opts.reviewIds && !eventIds.length) continue
    const diarySource = item.sourceRef ? opts.diarySources?.get(item.sourceRef) : undefined
    if (opts.diaryOnly && (item.kind !== 'event' || !diarySource)) continue
    if (item.sourceRef && (!diarySource || !item.quote.trim() || !diarySource.quote.includes(item.quote))) continue
    if (item.kind === 'event' && isPersonalDream(item.quote)) continue
    if (!item.sourceRef && item.quote && !opts.message?.includes(item.quote)) continue
    if (opts.origin === 'chat' && !item.quote && !eventIds.length) continue
    if (state.proposals.some(p => p.kind === item.kind && (norm(p.content) === norm(item.content)
      || (p.status === 'corrected' || p.status === 'dismissed') && norm(p.title) === norm(item.title)))) continue
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const source: Evidence[] = diarySource ? [{ ...diarySource, quote: item.quote }] : item.quote && opts.logId ? [{ kind: 'chat', id: opts.logId, quote: item.quote, date }] : []
    const evidence = eventIds.reduce((all, id) => combineEvidence(all, requireEvent(state, id).evidence), source)
    const p: Proposal = { id: randomUUID(), kind: item.kind, title: item.title, content: item.content, basis: item.basis, counterpoint: item.counterpoint,
      category: item.category, eventIds, articleId: opts.articleId ?? (item.articleId && opts.articleIds.has(item.articleId) ? item.articleId : undefined),
      eventDraft: item.kind === 'event' && item.eventDraft ? { ...item.eventDraft, date: approximateDate.safeParse(item.eventDraft.date).success ? item.eventDraft.date : '' } : undefined,
      chatReplyId: opts.chatReplyId, evidence, origin: diarySource ? 'diary' : opts.origin, status: 'pending', createdAt: now() }
    state.proposals.push(p)
    created.push(p)
  }
  return created.length
}

export const personalRoute = new Hono<{ Variables: AppVariables }>()
personalRoute.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
personalRoute.onError((error, c) => error instanceof WorkspaceError
  ? c.json({ error: error.message }, error.status)
  : c.json({ error: '本地百科操作未完成，请稍后重试。' }, 500))

personalRoute.get('/', async c => {
  const db = c.get('db'), userId = c.get('userId')
  const state = await importHistoricalAnalysis(db, userId)
  const articles = await readArticles(db, userId, state)
  return c.json({ events: state.events, proposals: state.proposals, articles, chapters: state.chapters ?? [], turningPoints: state.turningPoints ?? {}, dreams: (state.dreams ?? []).map(({ id, title, date, updatedAt }) => ({ id, title, date, updatedAt })), focusId: state.focusId, diaryFocusId: state.diaryFocusId, dreamFocusId: state.dreamFocusId, comparisonFocus: state.comparisonFocus })
})
personalRoute.get('/chat', async c => {
  const db = c.get('db'), userId = c.get('userId')
  const [messages, state] = await Promise.all([getChat(db, userId), getState(db, userId)])
  return c.json({ messages: messages.map(m => ({ ...m, evidence: state.chatEvidence?.[m.id] ?? [], dream: state.privateTurns?.includes(m.id) ?? false, dreamDraft: state.dreamDrafts?.[m.id] })) })
})
personalRoute.post('/diary-sources', async c => {
  const { entries } = await parse(c.req, z.object({ entries: diaryEntriesSchema }))
  const userId = c.get('userId'), id = hash([userId, entries])
  await c.get('db').insert(interviewDiaryBatches).values({ id, userId, entries }).onConflictDoNothing()
  return c.json({ id, count: entries.length }, 201)
})
personalRoute.post('/focus', async c => {
  const { id, clearDiary, dreamId, diaryId, comparison } = await parse(c.req, z.object({ id: key.nullable().optional(), clearDiary: z.boolean().optional(), diaryId: key.optional(), dreamId: key.nullable().optional(), comparison: comparisonInput.nullable().optional() }).refine(v => [v.id, v.dreamId, v.diaryId, v.comparison].filter(Boolean).length <= 1))
  const db = c.get('db'), userId = c.get('userId')
  if (diaryId) await importHistoricalAnalysis(db, userId)
  await changeState(db, userId, async (state, tx) => {
    if (comparison) {
      if (comparison.eventId) requireEvent(state, comparison.eventId)
      const article = comparison.articleId ? (await readArticles(tx, userId, state)).find(a => a.id === comparison.articleId && !a.deleted) : undefined
      if (comparison.articleId && !article) throw new WorkspaceError('找不到可对照的百科条目。', 404)
      if (article && comparison.eventId && !article.eventIds.includes(comparison.eventId)) throw new WorkspaceError('这件事不在该条目的关联事件里。')
      state.focusId = undefined; state.dreamFocusId = undefined; state.diaryFocusId = undefined
    }
    if (comparison !== undefined) state.comparisonFocus = comparison ?? undefined
    if (id || diaryId || dreamId) state.comparisonFocus = undefined
    if (diaryId) {
      if (!state.diarySeen.includes(diaryId)) throw new WorkspaceError('找不到这一批日记分析。', 404)
      state.diaryFocusId = diaryId; state.dreamFocusId = undefined; state.focusId = undefined
    }
    if (id) { requireProposal(state, id); state.dreamFocusId = undefined }
    if (dreamId && !state.dreams?.some(d => d.id === dreamId)) throw new WorkspaceError('找不到该梦境。', 404)
    if (dreamId) { state.focusId = undefined; state.diaryFocusId = undefined }
    if (dreamId !== undefined) state.dreamFocusId = dreamId ?? undefined
    if (id !== undefined) state.focusId = id ?? undefined
    if (clearDiary) state.diaryFocusId = undefined
  })
  return c.json({ ok: true })
})

const active = new Map<string, symbol>()
const RECENT = 16
personalRoute.post('/chat', async c => {
  const { message, searchDiary } = await parse(c.req, z.object({ message: text(24000), searchDiary: z.boolean().default(false) }))
  const db = c.get('db'), userId = c.get('userId')
  if (active.has(userId)) return c.json({ error: '这条对话正在回复，请稍候。' }, 409)
  const requestId = Symbol()
  active.set(userId, requestId)
  const release = () => { if (active.get(userId) === requestId) active.delete(userId) }
  c.header('Content-Type', 'application/x-ndjson; charset=UTF-8')
  return stream(c, async output => {
    const controller = new AbortController()
    output.onAbort(() => controller.abort())
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(120_000)])
    const emit = (value: object) => output.writeln(JSON.stringify(value))
    let saved = false
    try {
      await emit({ type: 'progress', phase: 'recall' })
      const state = await importHistoricalAnalysis(db, userId)
      const [history, docs] = await Promise.all([getChat(db, userId), memoryDocs(db, userId, state)])
      const dream = state.dreams?.find(d => d.id === state.dreamFocusId)
      const offerDream = !dream && isPersonalDream(message)
      const intent = diaryIntent(message, Boolean(state.diaryFocusId))
      const useDiary = !dream && !offerDream && (searchDiary || intent.lookup)
      if (useDiary) await emit({ type: 'progress', phase: 'diary' })
      const [recall, archive] = await Promise.all([
        dream || offerDream ? Promise.resolve({ mode: 'keyword' as const, hits: [] }) : searchMemory(db, userId, docs, message, signal),
        useDiary ? recallDiary(db, userId, message, { batchId: intent.all ? undefined : state.diaryFocusId, extractEvents: intent.extractEvents, signal }) : undefined,
      ])
      const diarySources = new Map(archive?.hits.map((d, i) => ['日记原文-' + (i + 1), d.evidence[0]] as const) ?? [])
      const focus = state.proposals.find(p => p.id === state.focusId)
      const diary = state.diaryFocusId ? state.proposals.filter(p => p.originId === state.diaryFocusId && p.status !== 'dismissed' && p.status !== 'corrected').slice(0, 12) : []
      const linked = focus ? docs.filter(d => focus.eventIds.includes(d.sourceId)) : []
      const comparison: ComparisonFocus | undefined = dream || offerDream ? undefined : state.comparisonFocus
      const comparedArticle = comparison?.articleId ? docs.find(d => d.kind === 'article' && d.sourceId === comparison.articleId) : undefined
      const comparedEvent = comparison?.eventId && (!comparison.articleId || comparedArticle?.relatedEventIds?.includes(comparison.eventId)) ? docs.find(d => d.kind === 'event' && d.sourceId === comparison.eventId) : undefined
      const primaryDocs = [comparedEvent, comparedArticle].flatMap(d => d ? [d] : [])
      const eventRecord = comparedEvent && state.events.find(e => e.id === comparedEvent.sourceId)
      const comparisonView = primaryDocs.length ? {
        selected: primaryDocs.map(d => ({ kind: d.kind, id: d.sourceId, title: d.title })),
        // Keep the first-person and later accounts visible even if a long event's searchable text was truncated.
        eventView: eventRecord && { date: eventRecord.date, dateNote: eventRecord.dateNote, recordedThought: eventRecord.outlook?.slice(0, 1200),
          recordedImpact: eventRecord.impact?.slice(0, 800), laterReflections: eventRecord.followups?.slice(-2).map(f => ({ date: f.date, reflection: f.reflection.slice(0, 600) })) },
        instruction: '优先对照选定材料。区分当时原话及其记录时间、可确认事实、事后回看、目前的百科表述。指出真正的分歧、反例或证据缺口；没有就直说，不为对照而制造冲突，也不擅自修订。',
      } : undefined
      const adjacentIds = new Set(comparedArticle?.relatedEventIds ?? [])
      const adjacent = docs.filter(d => (comparedArticle && d.kind === 'event' && adjacentIds.has(d.sourceId)) || (comparedEvent && d.kind === 'article' && d.relatedEventIds?.includes(comparedEvent.sourceId))).slice(0, 3)
      const matches = [...new Map([...primaryDocs, ...adjacent, ...linked, ...recall.hits].map(d => [d.id, d])).values()].slice(0, 8)
      const correctionHistory = correctionsForModel(state, message)
      const context = { summary: state.summary, comparison: comparisonView, ...(offerDream && { dreamDraft: true }), ...(archive && { diaryArchive: {
        sources: [...diarySources].map(([id, { quote, date, label }]) => ({ id, quote, date, label })),
        searchedEntries: archive.scanned, available: archive.available, dates: archive.dateFilters, extractEvents: intent.extractEvents,
      } }), ...(dream && { dream: { ...dream, notes: dream.notes.slice(-1) }, dreamNotice: '这是用户本次明确选入的梦境，只做联想，不作为现实或人格证据。' }), focus: focus && proposalForModel(focus), diaryAnalysis: diary.map(proposalForModel),
        memories: matches.map(docForModel), correctionHistory }
      const references = [...matches.flatMap(d => d.evidence.slice(0, 3)), ...(focus?.evidence.slice(0, 3) ?? []), ...diarySources.values(), ...diary.flatMap(p => p.evidence.slice(0, 3))]
      const evidence = combineEvidence([], references)
      const regularHistory = history.filter(m => !state.privateTurns?.includes(m.id))
      const visibleHistory = dream ? history.filter(m => !state.privateTurns?.includes(m.id) || state.dreamTurns?.[m.id] === dream.id) : regularHistory
      const recentStart = Math.max(0, regularHistory.length - RECENT)
      const unsummarized = Math.max(0, recentStart - state.summaryThrough)
      // If summary generation failed, retain a few extra turns in the context while retrying the summary.
      const visibleStart = unsummarized <= 8 ? Math.min(recentStart, state.summaryThrough) : recentStart
      const recent = (dream ? visibleHistory.slice(-RECENT) : regularHistory.slice(visibleStart)).map(({ role, content }) => ({ role: role as 'user' | 'assistant', content: content.slice(0, 8000) }))
      await emit({ type: 'progress', phase: 'reply', retrieval: recall.mode })
      let answer = ''
      const result = streamConversation([...recent, { role: 'user', content: message }], context, signal)
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'error') throw chunk.error
        if (chunk.type === 'text-delta') { answer += chunk.textDelta; await emit({ type: 'delta', text: chunk.textDelta }) }
      }
      if (!answer.trim() || signal.aborted) throw new Error('empty or cancelled')
      const { id: logId, assistantId } = await saveTurn(db, userId, message, answer, evidence, dream?.id, offerDream)
      saved = true
      release()
      await emit({ type: 'saved', id: assistantId, userId: logId, evidence, dream: Boolean(dream) || offerDream, dreamDraft: offerDream ? { userId: logId } : undefined })
      if (dream || offerDream) { await emit({ type: 'done', count: 0 }); return }
      try {
        const through = Math.min(recentStart, state.summaryThrough + 16)
        const older = through > state.summaryThrough ? regularHistory.slice(state.summaryThrough, through).map(({ role, content }) => ({ role, content: content.slice(0, 2500) })) : []
        // Second call is an editorial pass, not a second conversational agent.
        const captureContext = { ...context, inbox: state.proposals.slice(-12).map(p => ({ kind: p.kind, title: p.title, status: p.status })) }
        const captured = await captureTurn(message, answer.slice(0, 5000), captureContext, older, state.summary, AbortSignal.timeout(75_000))
        const count = await changeState(db, userId, fresh => {
          const correction = captured.focusedCorrection?.trim()
          if (focus && correction && message.includes(correction) && fresh.focusId === focus.id) {
            const item = fresh.proposals.find(p => p.id === focus.id && (p.status === 'pending' || p.status === 'corrected'))
            if (item) { item.status = 'corrected'; item.correction = correction }
          }
          if (older.length && captured.summary.trim() && fresh.summaryThrough === state.summaryThrough) { fresh.summary = captured.summary; fresh.summaryThrough = through }
          return addDrafts(fresh, captured.items, { origin: 'chat', logId, chatReplyId: assistantId, message, diarySources, diaryOnly: Boolean(archive && intent.extractEvents), articleIds: new Set(docs.filter(d => d.kind === 'article').map(d => d.sourceId)) })
        })
        const notice = archive ? !archive.available ? '没有可查询的日记原文。可在「分析日记」选文件后先保存到资料库。'
          : !archive.hits.length ? '没有找到匹配的日记原文，可以换个时间或主题再试。'
          : '本轮引用 ' + archive.hits.length + ' 篇日记的相关片段，未发送整批。' + (intent.extractEvents ? count ? ' 已生成 ' + count + ' 条待核对的事件草稿。' : ' 本轮没有新增可核对的事件草稿。' : '') : undefined
        await emit({ type: 'done', count, notice })
      } catch { await emit({ type: 'done', warning: '回复已保存。这条消息未能自动检查收件箱建议。' }) }
    } catch {
      if (!controller.signal.aborted) await emit({ type: 'error', error: saved ? '回复已保存。' : '这次回复未完成，未写入对话。请重试。' })
    } finally { release() }
  })
})

personalRoute.get('/search', async c => {
  const query = c.req.query('q')?.trim()
  if (!query || query.length > 300) throw new WorkspaceError('请输入不超过 300 字的检索词。')
  const db = c.get('db'), userId = c.get('userId')
  const state = await importHistoricalAnalysis(db, userId)
  return c.json(await searchMemory(db, userId, await memoryDocs(db, userId, state), query, c.req.raw.signal))
})
personalRoute.get('/evidence/:kind/:id', async c => {
  const db = c.get('db'), userId = c.get('userId'), id = c.req.param('id')
  const kind = c.req.param('kind')
  if (kind === 'chat') {
    const [row] = await db.select({ content: rawLogs.content }).from(rawLogs).where(and(eq(rawLogs.id, id), eq(rawLogs.userId, userId), eq(rawLogs.role, 'user')))
    if (row) return c.json(row)
  } else if (kind === 'diary') {
    const index = c.req.query('index')
    const [row] = await db.select({ entries: interviewDiaryBatches.entries }).from(interviewDiaryBatches).where(and(eq(interviewDiaryBatches.id, id), eq(interviewDiaryBatches.userId, userId)))
    if (index && /^\d+$/.test(index) && row?.entries[Number(index)]) return c.json(row.entries[Number(index)])
  } else if (kind === 'saved-diary') {
    const [row] = await db.select({ content: diaryEntries.content }).from(diaryEntries).where(and(eq(diaryEntries.id, id), eq(diaryEntries.userId, userId)))
    if (row) return c.json(row)
  }
  throw new WorkspaceError('原始记录已不在本机，此处仍保留当时的引用。', 404)
})

personalRoute.post('/events', async c => {
  const input = await parse(c.req, eventInput)
  const result = await changeState(c.get('db'), c.get('userId'), state => updateEvent(state, input))
  return c.json(result, 201)
})
personalRoute.patch('/events/:id', async c => {
  const input = await parse(c.req, eventInput), id = c.req.param('id')
  return c.json(await changeState(c.get('db'), c.get('userId'), state => updateEvent(state, input, id)))
})
personalRoute.post('/review', async c => {
  const { eventIds, articleId, eventOnly } = await parse(c.req, z.object({ eventIds: ids, articleId: key.optional(), eventOnly: z.boolean().default(false) }))
  const db = c.get('db'), userId = c.get('userId'), state = await getState(db, userId)
  const docs = await memoryDocs(db, userId, state)
  const article = articleId ? docs.find(d => d.kind === 'article' && d.sourceId === articleId) : undefined
  if (articleId && !article) throw new WorkspaceError('找不到待修订的条目。', 404)
  const related = [...new Set(eventIds)].map(id => requireEvent(state, id).id)
  if (related.length < (article || eventOnly ? 1 : 2)) throw new WorkspaceError(article || eventOnly ? '请选择至少一个参考事件。' : '请先选择至少两个事件再做复盘。')
  const relevant = docs.filter(d => d.kind === 'event' && related.includes(d.sourceId))
  const query = [article?.title, ...relevant.map(d => d.title + ' ' + d.text.slice(0, 250))].filter(Boolean).join(' ')
  let result: ModelDraft[]
  let referenceEvents = related
  try {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(100_000)])
    const recalled = await searchMemory(db, userId, docs.filter(d => !related.includes(d.sourceId) && d.sourceId !== articleId), query, signal)
    const supporting = recalled.hits.slice(0, 4)
    referenceEvents = [...related, ...supporting.filter(d => d.kind === 'event').map(d => d.sourceId)]
    result = await reviewEvents(relevant, correctionsForModel(state, query), article ? docForModel(article) : null, supporting, signal)
  }
  catch { throw new WorkspaceError('跨事件分析未完成，未写入新建议。', 409) }
  const articleIds = new Set(docs.filter(d => d.kind === 'article').map(d => d.sourceId))
  const count = await changeState(db, userId, fresh => addDrafts(fresh, result, { origin: 'review', reviewIds: referenceEvents, articleId, articleIds }))
  return c.json({ count })
})

personalRoute.get('/articles/:id/history', async c => {
  const db = c.get('db'), userId = c.get('userId')
  const revisions = await articleHistory(db, userId, await getState(db, userId), c.req.param('id'))
  if (!revisions.length) throw new WorkspaceError('找不到这个条目。', 404)
  return c.json({ revisions })
})
personalRoute.post('/articles', async c => {
  const input = await parse(c.req, articleInput), id = randomUUID(), userId = c.get('userId')
  await changeState(c.get('db'), userId, (state, tx) => writeArticle(tx, userId, state, id, attachEvidence(state, input, []), input.reason || '手动创建', 'create'))
  return c.json({ id }, 201)
})
personalRoute.patch('/articles/:id', async c => {
  const input = await parse(c.req, articleInput), id = c.req.param('id'), userId = c.get('userId')
  await changeState(c.get('db'), userId, async (state, tx) => {
    const last = (await articleHistory(tx, userId, state, id)).at(-1)
    if (!last || last.action === 'delete') throw new WorkspaceError('找不到可编辑的条目。', 404)
    await writeArticle(tx, userId, state, id, attachEvidence(state, input, last.evidence), input.reason || '手动修订', 'edit')
  })
  return c.json({ ok: true })
})
personalRoute.delete('/articles/:id', async c => {
  const id = c.req.param('id'), userId = c.get('userId')
  await changeState(c.get('db'), userId, async (state, tx) => {
    const last = (await articleHistory(tx, userId, state, id)).at(-1)
    if (!last || last.action === 'delete') throw new WorkspaceError('找不到可删除的条目。', 404)
    await writeArticle(tx, userId, state, id, last, '手动移入回收站', 'delete')
  })
  return c.json({ ok: true })
})
personalRoute.post('/articles/:id/restore', async c => {
  const { index } = await parse(c.req, z.object({ index: z.number().int().nonnegative() }))
  const id = c.req.param('id'), userId = c.get('userId')
  await changeState(c.get('db'), userId, async (state, tx) => {
    const revision = (await articleHistory(tx, userId, state, id))[index]
    if (!revision || revision.action === 'delete') throw new WorkspaceError('找不到可恢复的版本。', 404)
    await writeArticle(tx, userId, state, id, revision, `恢复第 ${index + 1} 版`, 'restore')
  })
  return c.json({ ok: true })
})
personalRoute.post('/proposals/:id', async c => {
  const input = await parse(c.req, actInput), id = c.req.param('id'), userId = c.get('userId')
  const result = await changeState(c.get('db'), userId, async (state, tx) => {
    const p = requireProposal(state, id)
    if (p.status === 'accepted' || p.status === 'dismissed') throw new WorkspaceError('这条建议已处理。', 409)
    if (input.action === 'correct') { p.status = 'corrected'; p.correction = input.correction; return { id } }
    if (input.action === 'classify') {
      p.kind = input.kind
      return { ok: true }
    }
    if (input.action === 'dismiss') { p.status = 'dismissed'; return { id } }
    p.status = 'accepted'
    if (input.action === 'event') return { id: updateEvent(state, input.event, input.target, p.evidence).id }
    const articleId = input.target ?? randomUUID()
    const last = input.target ? (await articleHistory(tx, userId, state, input.target)).at(-1) : undefined
    if (input.target && (!last || last.action === 'delete')) throw new WorkspaceError('找不到可修订的条目。', 404)
    const article = attachEvidence(state, input.article, combineEvidence(last?.evidence ?? [], p.evidence))
    await writeArticle(tx, userId, state, articleId, article, input.article.reason || (last ? '确认 AI 修订草稿' : '确认 AI 新建草稿'), last ? 'edit' : 'create')
    return { id: articleId }
  })
  return c.json(result)
})

personalRoute.post('/chapters', async c => {
  const input = await parse(c.req, z.object({ title: text(180), introduction: optionalText(3500) }))
  const chapter = await changeState(c.get('db'), c.get('userId'), state => {
    const chapters = state.chapters ??= []
    const chapter = { ...input, id: randomUUID(), order: chapters.length }
    chapters.push(chapter)
    return chapter
  })
  return c.json(chapter, 201)
})
personalRoute.patch('/chapters/:id', async c => {
  const input = await parse(c.req, z.object({ title: text(180), introduction: optionalText(3500), order: z.number().int().min(0).optional() }))
  return c.json(await changeState(c.get('db'), c.get('userId'), state => {
    const chapter = state.chapters?.find(ch => ch.id === c.req.param('id'))
    if (!chapter) throw new WorkspaceError('找不到这个人生章节。', 404)
    Object.assign(chapter, { title: input.title, introduction: input.introduction, order: input.order ?? chapter.order })
    return chapter
  }))
})
personalRoute.post('/events/:id/followups', async c => {
  const input = await parse(c.req, z.object({ date: z.string().date(), outcome: text(5000), reflection: optionalText(4000) }))
  const result = await changeState(c.get('db'), c.get('userId'), state => {
    const event = requireEvent(state, c.req.param('id'))
    const followup = { id: randomUUID(), ...input }
    ;(event.followups ??= []).push(followup)
    event.updatedAt = now()
    return followup
  })
  return c.json(result, 201)
})
personalRoute.post('/articles/:id/turning-points', async c => {
  const input = await parse(c.req, z.object({ date: approximateDate, before: text(2500), after: text(2500), why: text(3000), eventId: key.optional() }))
  const db = c.get('db'), userId = c.get('userId'), id = c.req.param('id')
  const point = await changeState(db, userId, async (state, tx) => {
    const last = (await articleHistory(tx, userId, state, id)).at(-1)
    if (!last || last.action === 'delete') throw new WorkspaceError('找不到这个条目。', 404)
    if (input.eventId) requireEvent(state, input.eventId)
    const point = { id: randomUUID(), ...input }
    const all = state.turningPoints ??= {}
    ;(all[id] ??= []).push(point)
    return point
  })
  return c.json(point, 201)
})
personalRoute.post('/gaps', async c => {
  const db = c.get('db'), userId = c.get('userId'), state = await getState(db, userId)
  const docs = (await memoryDocs(db, userId, state)).filter(doc => doc.kind === 'event').slice(0, 12)
  if (docs.length < 2) throw new WorkspaceError('先记下至少两个事件，再让 AI 找对照材料的缺口。')
  let result: ModelDraft[]
  try { result = await findGaps(docs, correctionsForModel(state, docs.map(x => x.title).join(' ')), AbortSignal.timeout(100_000)) }
  catch { throw new WorkspaceError('本次未能完成资料缺口分析，没有写入新建议。', 409) }
  const count = await changeState(db, userId, fresh => addDrafts(fresh, result, { origin: 'review', reviewIds: docs.map(d => d.sourceId), articleIds: new Set() }))
  return c.json({ count })
})

const dreamInput = z.object({ title: text(300), date: approximateDate, original: text(24000), feelings: optionalText(4500), associations: optionalText(4500) })
const requireDream = (state: PersonalState, id: string) => {
  const result = state.dreams?.find(d => d.id === id)
  if (!result) throw new WorkspaceError('找不到该梦境。', 404)
  return result
}
personalRoute.post('/chat/dream-drafts/:replyId', async c => {
  const action = await parse(c.req, z.discriminatedUnion('action', [
    z.object({ action: z.literal('dismiss') }), z.object({ action: z.literal('save'), dream: dreamInput }),
  ]))
  const replyId = c.req.param('replyId')
  return c.json(await changeState(c.get('db'), c.get('userId'), state => {
    const draft = state.dreamDrafts?.[replyId]
    if (!draft) throw new WorkspaceError('这条梦境建议已处理。', 404)
    delete state.dreamDrafts![replyId]
    if (action.action === 'dismiss') return { ok: true }
    const dream = { ...action.dream, id: randomUUID(), notes: [], updatedAt: now() }
    ;(state.dreams ??= []).push(dream)
    const turns = (state.dreamTurns ??= {})
    turns[draft.userId] = turns[replyId] = dream.id
    return { ok: true, id: dream.id }
  }))
})
personalRoute.get('/dreams/:id', async c => c.json(requireDream(await getState(c.get('db'), c.get('userId')), c.req.param('id'))))
personalRoute.post('/dreams', async c => {
  const input = await parse(c.req, dreamInput)
  const dream = await changeState(c.get('db'), c.get('userId'), state => {
    const value = { ...input, id: randomUUID(), notes: [], updatedAt: now() }
    ;(state.dreams ??= []).push(value)
    return value
  })
  return c.json(dream, 201)
})
personalRoute.patch('/dreams/:id', async c => {
  const input = await parse(c.req, dreamInput)
  return c.json(await changeState(c.get('db'), c.get('userId'), state => {
    const value = requireDream(state, c.req.param('id'))
    Object.assign(value, input, { updatedAt: now() })
    return value
  }))
})
personalRoute.post('/dreams/:id/analyze', async c => {
  const db = c.get('db'), userId = c.get('userId'), id = c.req.param('id')
  const { title, original, feelings, associations } = requireDream(await getState(db, userId), id)
  let text: string
  try { text = await analyzeDream({ title, original, feelings, associations }, AbortSignal.timeout(100_000)) }
  catch { throw new WorkspaceError('这次没有生成梦境联想，原文仍已保存。', 409) }
  return c.json(await changeState(db, userId, state => {
    const dream = requireDream(state, id)
    if (dream.title !== title || dream.original !== original || dream.feelings !== feelings || dream.associations !== associations) throw new WorkspaceError('梦境内容已修改，请重新分析。', 409)
    dream.notes.push({ at: now(), text })
    return dream
  }))
})
personalRoute.get('/book.zip', async c => {
  const db = c.get('db'), userId = c.get('userId'), dreamsOnly = c.req.query('volume') === 'dreams'
  const buffer = await exportPersonalBook(db, userId, await getState(db, userId), dreamsOnly)
  c.header('Content-Type', 'application/zip')
  c.header('Content-Disposition', `attachment; filename="${dreamsOnly ? 'dream-journal' : 'personal-history'}.zip"`)
  return c.body(Uint8Array.from(buffer).buffer)
})
