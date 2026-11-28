import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { APICallError, tool } from 'ai'
import { diaryEntries, interviewDiaryBatches, rawLogs, STRUCTURED_FACT_CATEGORIES } from '../db/schema.js'
import { articleChapterIds, chapterFor, findArticleTarget, type ArticleTarget } from '../personal/articleTopics.js'
import { archiveDiaries, hash, articleHistory, articleVersion, changeState, combineEvidence, getChat, getState, importHistoricalAnalysis, now, readArticles, saveTurn, WorkspaceError, writeArticle } from '../personal/store.js'
import { compareSlices } from '../personal/sliceCompare.js'
import { memoryDocs, searchMemory } from '../personal/search.js'
import { recallChat } from '../personal/chatRecall.js'
import { aliasLength, aliasLimit, matchesContextName, nameKey, uniqueAliases } from '../personal/contextNames.js'
import { diaryIntent, isPersonalDream, recallDiary } from '../personal/diaryRecall.js'
import { localSettingsRoute } from './localSettings.js'
import { applyProfileDrafts, profileContext, type ProfileTurnUpdate } from '../personal/profile.js'
import { profileRoute } from './profile.js'
import { trackLocalRequest } from '../personal/maintenance.js'
import { diaryEntriesSchema } from '../llm/diarySchemas.js'
import { analyzeDream, draftArticleMerge, findGaps, captureTurn, correctionsForModel, docForModel, proposalForModel, reviewEvents, streamConversation, suggestDuplicateArticles, type ModelDraft } from '../personal/model.js'
import type { Article, ComparisonFocus, Evidence, LifeContext, LifeEvent, PersonalState, Proposal } from '../personal/types.js'
import { exportPersonalBook } from '../personal/export.js'
import type { AppVariables } from '../types.js'

const category = z.enum(STRUCTURED_FACT_CATEGORIES)
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !v.includes('\0'))
const optionalText = (max: number) => z.string().trim().max(max).refine(v => !v.includes('\0')).default('')
const key = text(120)
const ids = z.array(key).max(12).default([])
const contextEventIds = z.array(key).max(1000)
const approximateDate = z.string().refine(value => !value || /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value) || z.string().date().safeParse(value).success).default('')
const sliceInput = z.object({ kind: z.enum(['context', 'chapter']), id: key })
const comparisonInput = z.object({
  eventId: key.optional(),
  articleId: key.optional(),
  sliceA: sliceInput.optional(),
  sliceB: sliceInput.optional(),
}).refine(v => Boolean(v.eventId || v.articleId || (v.sliceA && v.sliceB)))
const eventInput = z.object({ title: text(600), date: approximateDate, dateNote: optionalText(120), cause: optionalText(3000), outcome: optionalText(4000), facts: text(5000), analysis: optionalText(3000),
  outlook: optionalText(4000), impact: optionalText(4000), prediction: optionalText(3000), chapterId: key.optional(), contextIds: contextEventIds.optional(), topics: z.array(text(24)).max(12).optional(), importance: z.enum(['regular', 'milestone', 'turning']).nullable().optional() })
const aliasesInput = z.array(text(aliasLength)).max(aliasLimit).optional()
const contextInput = z.object({ aliases: aliasesInput, kind: z.enum(['person', 'environment']), name: text(160), role: optionalText(200), period: optionalText(120),
  description: optionalText(5000), impact: optionalText(4000), eventIds: contextEventIds.default([]),
  links: z.array(z.object({ id: key.optional(), targetId: key, label: text(160), period: optionalText(120), eventIds: ids })).max(24).default([]) })
const articleInput = z.object({ title: text(600), category, chapter: z.enum(articleChapterIds).optional(), fact: text(5000), limits: z.string().trim().max(5000).optional(), reason: optionalText(500), version: key.optional(), eventIds: contextEventIds.default([]) })
const actInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('classify'), kind: z.enum(['event', 'article', 'question']) }),
  z.object({ action: z.literal('correct'), correction: text(1500) }),
  z.object({ action: z.literal('event'), target: key.optional(), event: eventInput }),
  z.object({ action: z.literal('article'), target: key.optional(), article: articleInput, quick: z.boolean().optional() }),
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
  const { contextIds, ...fields } = input
  const selected = contextIds === undefined ? undefined : new Set(contextIds)
  const cards = state.contexts ?? []
  if (selected && [...selected].some(cardId => !cards.some(card => card.id === cardId))) throw new WorkspaceError('找不到所选的人物或环境档案。', 404)
  if (input.chapterId && !state.chapters?.some(ch => ch.id === input.chapterId)) throw new WorkspaceError('找不到这个人生章节。', 404)
  const result: LifeEvent = { ...existing, id: existing?.id ?? randomUUID(), ...fields, chapterId: input.chapterId, topics: input.topics === undefined ? existing?.topics : [...new Set(input.topics)], importance: input.importance === null ? undefined : input.importance ?? existing?.importance, evidence: combineEvidence(existing?.evidence ?? [], refs), updatedAt: now() }
  if (existing) state.events[state.events.indexOf(existing)] = result
  else state.events.push(result)
  // Omitted means leave associations alone; an explicit empty list clears direct links.
  if (selected) for (const card of cards) {
    const has = card.eventIds.includes(result.id), wants = selected.has(card.id)
    if (has === wants) continue
    if (wants && card.eventIds.length >= 1000) throw new WorkspaceError('有档案的关联事件已达上限。', 409)
    card.eventIds = wants ? [...card.eventIds, result.id] : card.eventIds.filter(eventId => eventId !== result.id)
    card.updatedAt = result.updatedAt
  }
  return result
}
function attachEvidence(state: PersonalState, input: z.infer<typeof articleInput>, refs: Evidence[]): Article {
  const eventIds = [...new Set(input.eventIds)]
  return { title: input.title, category: input.category, chapter: input.chapter, fact: input.fact, limits: input.limits, eventIds,
    evidence: eventIds.reduce((all, id) => combineEvidence(all, requireEvent(state, id).evidence), refs) }
}
function addDrafts(state: PersonalState, items: ModelDraft[], opts: { origin: 'chat' | 'review'; logId?: string; chatReplyId?: string; message?: string; diarySources?: Map<string, Evidence>; chatSources?: Map<string, Evidence>; diaryOnly?: boolean; reviewIds?: string[]; articleId?: string; articles: ArticleTarget[]; revisionBase?: { id: string; version: string; correction?: string } }) {
  const created: Proposal[] = []
  const norm = (s: string) => s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  for (const item of items) {
    const eventIds = [...new Set(item.eventIds)].filter(id => state.events.some(e => e.id === id) && (!opts.reviewIds || opts.reviewIds.includes(id)))
    if (opts.reviewIds && !eventIds.length) continue
    const diarySource = item.sourceRef ? opts.diarySources?.get(item.sourceRef) : undefined
    if (opts.diaryOnly && (item.kind !== 'event' || !diarySource)) continue
    const archivedSource = diarySource ?? (item.sourceRef ? opts.chatSources?.get(item.sourceRef) : undefined)
    if (item.sourceRef && (!archivedSource || !item.quote.trim() || !archivedSource.quote.includes(item.quote))) continue
    if (item.kind === 'event' && isPersonalDream(item.quote)) continue
    if (!item.sourceRef && item.quote && !opts.message?.includes(item.quote)) continue
    if (opts.origin === 'chat' && !item.quote && !eventIds.length) continue
    const target = item.kind === 'event' ? undefined : findArticleTarget(opts.articles, { ...item, articleId: opts.articleId ?? item.articleId })
    if (opts.articleId && !target) continue
    const revision = opts.revisionBase
    const replaces = item.kind === 'article' && target && revision?.id === target.id &&
      (opts.articleId === target.id || Boolean(revision.correction && !item.sourceRef && item.quote.includes(revision.correction)))
    const baseVersion = replaces ? revision.version : undefined
    if (state.proposals.some(p => p.kind === item.kind && p.articleId === target?.id && p.baseVersion === baseVersion && (
      norm(p.content) === norm(item.content) || item.kind === 'question' && !target && (p.status === 'corrected' || p.status === 'dismissed') && norm(p.title) === norm(item.title)))) continue
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const source: Evidence[] = archivedSource ? [{ ...archivedSource, quote: item.quote }] : item.quote && opts.logId ? [{ kind: 'chat', id: opts.logId, quote: item.quote, date }] : []
    const evidence = eventIds.reduce((all, id) => combineEvidence(all, requireEvent(state, id).evidence), source)
    const p: Proposal = { id: randomUUID(), kind: item.kind, title: item.title, content: item.content, basis: item.basis, counterpoint: item.counterpoint,
      category: target?.category ?? item.category, chapter: target ? target.chapter : item.chapter ?? undefined, eventIds, articleId: target?.id,
      operation: item.kind === 'article' && target ? replaces ? 'revise' : 'supplement' : undefined, baseVersion,
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
  return c.json({ contexts: state.contexts ?? [], contextSuggestions: state.contextSuggestions ?? [], events: state.events, proposals: state.proposals, profileReport: state.profileReport ?? null, articles, chapters: state.chapters ?? [], turningPoints: state.turningPoints ?? {}, dreams: (state.dreams ?? []).map(({ id, title, date, updatedAt }) => ({ id, title, date, updatedAt })), focusId: state.focusId, diaryFocusId: state.diaryFocusId, dreamFocusId: state.dreamFocusId, comparisonFocus: state.comparisonFocus })
})
personalRoute.get('/chat', async c => {
  const db = c.get('db'), userId = c.get('userId')
  const [messages, state] = await Promise.all([getChat(db, userId), getState(db, userId)])
  return c.json({ messages: messages.map(m => ({ ...m, evidence: state.chatEvidence?.[m.id] ?? [], dream: state.privateTurns?.includes(m.id) ?? false, dreamDraft: state.dreamDrafts?.[m.id] })) })
})
personalRoute.post('/diary-sources', async c => {
  const { entries, origin } = await parse(c.req, z.object({ entries: diaryEntriesSchema, origin: z.enum(['import', 'journal']).default('import') }))
  const id = await archiveDiaries(c.get('db'), c.get('userId'), entries, origin)
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
      for (const slice of [comparison.sliceA, comparison.sliceB]) {
        if (!slice) continue
        const found = slice.kind === 'context'
          ? state.contexts?.some(c => c.id === slice.id)
          : state.chapters?.some(c => c.id === slice.id)
        if (!found) throw new WorkspaceError('找不到选定对比的时期或环境档案。', 404)
      }
      state.focusId = undefined; state.dreamFocusId = undefined; state.diaryFocusId = undefined
    }
    if (comparison !== undefined) state.comparisonFocus = comparison ?? undefined
    if (id || diaryId || dreamId) state.comparisonFocus = undefined
    if (diaryId) {
      if (!state.diarySeen.includes(diaryId)) throw new WorkspaceError('找不到这一批日记分析。', 404)
      state.diaryFocusId = diaryId; state.dreamFocusId = undefined; state.focusId = undefined
    }
    if (id) {
      const proposal = requireProposal(state, id)
      if (proposal.originId?.startsWith('profile:')) throw new WorkspaceError('请从个人画像打开这项讨论。', 409)
      state.dreamFocusId = undefined
    }
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
  const { message, searchDiary, mode: requestedMode, allowDiary } = await parse(c.req, z.object({ message: text(24000), searchDiary: z.boolean().default(false), mode: z.enum(['chat', 'event', 'dream']).optional(), allowDiary: z.boolean().default(true) }))
  const db = c.get('db'), userId = c.get('userId')
  if (active.has(userId)) return c.json({ error: '这条对话正在回复，请稍候。' }, 409)
  const requestId = Symbol()
  active.set(userId, requestId)
  const release = () => { if (active.get(userId) === requestId) active.delete(userId) }
  c.header('Content-Type', 'application/x-ndjson; charset=UTF-8')
  return stream(c, async output => {
    const finishWork = trackLocalRequest()
    const controller = new AbortController()
    output.onAbort(() => controller.abort())
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(120_000)])
    const emit = (value: object) => output.writeln(JSON.stringify(value))
    let saved = false
    try {
      await emit({ type: 'progress', phase: 'recall' })
      const state = await importHistoricalAnalysis(db, userId)
      const [history, docs] = await Promise.all([getChat(db, userId), memoryDocs(db, userId, state)])
      const mode = requestedMode ?? (state.dreamFocusId ? 'dream' : 'chat')
      const dream = mode === 'dream' ? state.dreams?.find(d => d.id === state.dreamFocusId) : undefined
      const offerDream = !dream && (mode === 'dream' || (mode === 'chat' && isPersonalDream(message)))
      const isolated = Boolean(dream) || offerDream
      const privateIds = new Set(state.privateTurns ?? [])
      const regularHistory = history.filter(m => !privateIds.has(m.id) && !state.dreamTurns?.[m.id])
      const intent = diaryIntent(message, Boolean(state.diaryFocusId))
      const canSearchDiary = !isolated && allowDiary && !intent.optedOut
      const archives: Awaited<ReturnType<typeof recallDiary>>[] = []
      const diarySources = new Map<string, Evidence>()
      const recalledDocs = new Map<string, Awaited<ReturnType<typeof memoryDocs>>[number]>()
      const lookupDiary = async (query: string, all = false) => {
        await emit({ type: 'progress', phase: 'diary' })
        const archive = await recallDiary(db, userId, query, { batchId: all || intent.all ? undefined : state.diaryFocusId, extractEvents: intent.extractEvents, signal })
        archives.push(archive)
        return { available: archive.available, candidatesInScope: archive.scanned, excerpts: archive.hits.map(d => {
          const existing = [...diarySources].find(([, e]) => e.kind === d.evidence[0].kind && e.id === d.evidence[0].id && e.index === d.evidence[0].index && e.quote === d.evidence[0].quote)
          const id = existing?.[0] ?? '日记原文-' + (diarySources.size + 1)
          diarySources.set(id, d.evidence[0])
          const { quote, date, label } = d.evidence[0]
          return { id, quote, date, label }
        }) }
      }
      const chatSources = new Map<string, Evidence>()
      const lookupChat = async (query: string, period = '') => {
        await emit({ type: 'progress', phase: 'chat-history' })
        const result = await recallChat(db, userId, regularHistory, query, period, signal)
        return { excerpts: result.hits.slice(0, 5).map(hit => {
          const source = hit.evidence[0]
          const existing = [...chatSources].find(([, e]) => e.id === source.id && e.quote === source.quote)
          const id = existing?.[0] ?? '对话原文-' + (chatSources.size + 1)
          chatSources.set(id, source)
          return { id, quote: source.quote, date: source.date }
        }) }
      }
      // Explicit search also works for API endpoints that do not implement tool calls.
      const explicitChatQuery = !isolated ? /^(?:请)?查(?:一下|找)?(?:长期)?(?:聊天|对话)原文[：:]\s*(.{1,400})$/su.exec(message)?.[1] : undefined
      const explicitChat = explicitChatQuery?.trim() ? await lookupChat(explicitChatQuery.trim()) : undefined
      const explicitDiary = canSearchDiary && (searchDiary || intent.lookup) ? await lookupDiary(message) : undefined
      const focus = isolated ? undefined : state.proposals.find(p => p.id === state.focusId)
      const diary = !isolated && allowDiary && !intent.optedOut && state.diaryFocusId ? state.proposals.filter(p => p.originId === state.diaryFocusId && p.status !== 'dismissed' && p.status !== 'corrected').slice(0, 12) : []
      const profileFocus = focus?.originId?.startsWith(`profile:${state.profileReport?.id}:`) ? focus : undefined
      const profile = isolated ? [] : profileContext(state, profileFocus?.originId?.split(':').at(-1), message)
      const focusArticle = focus?.articleId ? docs.find(d => d.kind === 'article' && d.sourceId === focus.articleId) : undefined
      const linked = focus ? [...(focusArticle ? [focusArticle] : []), ...docs.filter(d => d.kind === 'event' && focus.eventIds.includes(d.sourceId))] : []
      const comparison: ComparisonFocus | undefined = dream || offerDream ? undefined : state.comparisonFocus
      const comparedArticle = comparison?.articleId ? docs.find(d => d.kind === 'article' && d.sourceId === comparison.articleId) : undefined
      const comparedEvent = comparison?.eventId && (!comparison.articleId || comparedArticle?.relatedEventIds?.includes(comparison.eventId)) ? docs.find(d => d.kind === 'event' && d.sourceId === comparison.eventId) : undefined
      const primaryDocs = [comparedEvent, comparedArticle].flatMap(d => d ? [d] : [])
      const eventRecord = comparedEvent && state.events.find(e => e.id === comparedEvent.sourceId)
      const sliceDiff = comparison?.sliceA && comparison?.sliceB
        ? compareSlices(state, await readArticles(db, userId, state), comparison.sliceA, comparison.sliceB)
        : null
      const packSlice = (s: NonNullable<typeof sliceDiff>['a']) => ({
        title: s.title, subtitle: s.subtitle, summary: s.summary.slice(0, 600),
        events: s.events.slice(0, 8).map(e => ({
          id: e.id, date: e.dateNote || e.date || '时间未定', title: e.title,
          facts: e.facts.slice(0, 260),
          ...(e.outlook && { outlook: e.outlook.slice(0, 260) }),
          ...(e.impact && { impact: e.impact.slice(0, 220) }),
          quotes: e.evidence.slice(0, 2).map(q => ({ date: q.date, quote: q.quote.slice(0, 220) })),
        })),
        articles: s.articles.slice(0, 8).map(a => ({ id: a.id, title: a.title, fact: a.fact.slice(0, 260), ...(a.limits && { limits: a.limits.slice(0, 180) }) })),
      })
      const comparisonView = (primaryDocs.length || sliceDiff) ? {
        selected: primaryDocs.map(d => ({ kind: d.kind, id: d.sourceId, title: d.title })),
        // Keep the first-person and later accounts visible even if a long event's searchable text was truncated.
        eventView: eventRecord && { date: eventRecord.date, dateNote: eventRecord.dateNote, recordedThought: eventRecord.outlook?.slice(0, 1200),
          recordedImpact: eventRecord.impact?.slice(0, 800), laterReflections: eventRecord.followups?.slice(-2).map(f => ({ date: f.date, reflection: f.reflection.slice(0, 600) })) },
        ...(sliceDiff && {
          sliceComparison: {
            a: packSlice(sliceDiff.a),
            b: packSlice(sliceDiff.b),
            sharedTopics: sliceDiff.sharedArticles.map(a => a.title),
            onlyATopics: sliceDiff.onlyAArticles.map(a => a.title),
            onlyBTopics: sliceDiff.onlyBArticles.map(a => a.title),
          },
        }),
        instruction: sliceDiff
          ? '优先对照这两个时期或环境的切片：比较在这两个阶段/环境下，用户看重的东西、行动方式、关系边界或看法有哪些真正发生了变化，哪些保持稳定；区分当时的原话、事后回看与现在的百科表述；指出反例或缺失证据，没有足够材料就直说，不为对照而制造冲突。'
          : '优先对照选定材料。区分当时原话及其记录时间、可确认事实、事后回看、目前的百科表述。指出真正的分歧、反例或证据缺口；没有就直说，不为对照而制造冲突，也不擅自修订。',
      } : undefined
      const sliceDocs = sliceDiff
        ? docs.filter(d =>
            (d.kind === 'event' && (sliceDiff.a.events.some(e => e.id === d.sourceId) || sliceDiff.b.events.some(e => e.id === d.sourceId))) ||
            (d.kind === 'article' && (sliceDiff.a.articles.some(a => a.id === d.sourceId) || sliceDiff.b.articles.some(a => a.id === d.sourceId)))).slice(0, 8)
        : []
      const adjacentIds = new Set(comparedArticle?.relatedEventIds ?? [])
      const adjacent = docs.filter(d => (comparedArticle && d.kind === 'event' && adjacentIds.has(d.sourceId)) || (comparedEvent && d.kind === 'article' && d.relatedEventIds?.includes(comparedEvent.sourceId))).slice(0, 3)
      const matches = [...new Map([...primaryDocs, ...sliceDocs, ...adjacent, ...linked].map(d => [d.id, d])).values()].slice(0, 10)
      const correctionHistory = isolated ? [] : correctionsForModel(state, message)
      const context = { mode, ...(explicitChat && { chatArchive: { sources: explicitChat.excerpts } }), summary: isolated ? undefined : state.summary, comparison: comparisonView, ...(offerDream && { dreamDraft: true }), ...(explicitDiary && { diaryArchive: {
        sources: explicitDiary.excerpts, available: explicitDiary.available, extractEvents: intent.extractEvents,
      } }), ...(dream && { dream: { ...dream, notes: dream.notes.slice(-1) }, dreamNotice: '这是用户本次明确选入的梦境，只做联想，不作为现实或人格证据。' }), focus: focus && proposalForModel(allowDiary && !intent.optedOut ? focus : { ...focus, evidence: focus.evidence.filter(e => e.kind !== 'diary') }), profile, profileDiscussion: Boolean(profileFocus), diaryAnalysis: diary.map(proposalForModel),
        memories: matches.map(docForModel), correctionHistory }
      // Read-only access to the active user's archive with a bounded per-turn budget.
      let remainingLookups = 3
      const tools = isolated ? undefined : {
        search_memories: tool({
          description: '查找事件、百科、人物、环境或历史分析。只在需要核对过去记录或解释时使用；不要用来闲聊。',
          parameters: z.object({ query: text(400), kind: z.enum(['all', 'event', 'article', 'context', 'analysis']), period: z.string().max(10).describe('可选的事件发生年月日，例如 2024 或 2024-06；不限制填空字符串') }),
          execute: async ({ query, kind, period }) => {
            if (remainingLookups-- <= 0) return { note: '本轮已达到检索上限。' }
            await emit({ type: 'progress', phase: 'memory' })
            const date = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(period) ? period : ''
            const pool = docs.filter(d => (kind === 'all' || d.kind === kind) && (allowDiary && !intent.optedOut || d.kind !== 'analysis') && (!date || d.kind === 'event' && state.events.some(event => event.id === d.sourceId && event.date.startsWith(date))))
            const result = await searchMemory(db, userId, pool, query, signal)
            const hits = result.hits.slice(0, 5)
            for (const hit of hits) recalledDocs.set(hit.id, hit)
            return { matches: hits.map(docForModel) }
          },
        }),
        search_chat_history: tool({
          description: '搜索同一个长期对话里用户以前亲口说过的原话（不含 AI 回复、梦境私密对话）。查旧经历、原话、跨时期对照或不同解释的反例时使用。query 写具体人名、经历或主题，period 可按消息记录时间筛选。',
          parameters: z.object({ query: text(400), period: z.string().max(10).describe('可选记录时间：YYYY、YYYY-MM 或 YYYY-MM-DD；不限则填空字符串') }),
          execute: async ({ query, period }) => remainingLookups-- <= 0 ? { note: '本轮已达到检索上限。' } : lookupChat(query, period),
        }),
        ...(canSearchDiary && { search_diary: tool({
          description: '查已保存的日记原文片段，用于核对原话或寻找不同阶段的经历和反例；不是全批分析。',
          parameters: z.object({ query: text(400), scope: z.enum(['selected', 'all']) }),
          execute: async ({ query, scope }) => remainingLookups-- <= 0 ? { note: '本轮已达到检索上限。' } : lookupDiary(query, scope === 'all'),
        }) }),
      }
      const visibleHistory = isolated ? history.filter(m => dream && state.dreamTurns?.[m.id] === dream.id) : regularHistory
      const recentStart = Math.max(0, regularHistory.length - RECENT)
      const unsummarized = Math.max(0, recentStart - state.summaryThrough)
      // If summary generation failed, retain a few extra turns in the context while retrying the summary.
      const visibleStart = unsummarized <= 8 ? Math.min(recentStart, state.summaryThrough) : recentStart
      const recent = (isolated ? visibleHistory.slice(-RECENT) : regularHistory.slice(visibleStart)).map(({ role, content }) => ({ role: role as 'user' | 'assistant', content: (role === 'assistant' ? content.replace(/【对话原文-\d+】/gu, '') : content).slice(0, 8000) }))
      let answer = '', withoutTools = false
      const reply = async (capabilities?: typeof tools) => {
        const result = streamConversation([...recent, { role: 'user', content: message }], context, signal, capabilities)
        for await (const chunk of result.fullStream) {
          if (chunk.type === 'error') throw chunk.error
          if (chunk.type === 'text-delta') { answer += chunk.textDelta; await emit({ type: 'delta', text: chunk.textDelta }) }
        }
      }
      try { await reply(tools) } catch (error) {
        if (!tools || answer || remainingLookups < 3 || signal.aborted || !APICallError.isInstance(error) ||
          ![400, 422, 501].includes(error.statusCode ?? 0) || !/tools?|function.call/i.test(error.message)) throw error
        withoutTools = true
        await reply()
      }
      if (signal.aborted) throw new Error('cancelled')
      if (!answer.trim()) {
        await emit({ type: 'error', error: '模型没有生成回复，未写入对话。可尝试缩小查询范围后重试。' })
        return
      }
      const usedDocs = [...new Map([...matches, ...recalledDocs.values()].map(doc => [doc.id, doc])).values()]
      const citedChat = [...new Set([...answer.matchAll(/【(对话原文-\d+)】/gu)].map(match => match[1]))]
        .flatMap(id => { const source = chatSources.get(id); return source ? [{ ...source, label: id }] : [] })
      const evidence = combineEvidence([...diarySources.values(), ...usedDocs.flatMap(d => d.evidence.slice(0, 3)), ...(focus?.evidence.slice(0, 3) ?? []), ...diary.flatMap(p => p.evidence.slice(0, 3))], citedChat)
      const { id: logId, assistantId } = await saveTurn(db, userId, message, answer, evidence, dream?.id, offerDream)
      saved = true
      release()
      await emit({ type: 'saved', id: assistantId, userId: logId, evidence, dream: Boolean(dream) || offerDream, dreamDraft: offerDream ? { userId: logId } : undefined })
      if (dream || offerDream) { await emit({ type: 'done', count: 0 }); return }
      try {
        const through = Math.min(recentStart, state.summaryThrough + 16)
        const older = through > state.summaryThrough ? regularHistory.slice(state.summaryThrough, through).map(({ role, content }) => ({ role, content: content.slice(0, 2500) })) : []
        // Second call is an editorial pass, not a second conversational agent.
        const archive = archives.at(-1)
        const articles: ArticleTarget[] = docs.filter(d => d.kind === 'article').map(d => ({ id: d.sourceId, title: d.title, category: d.articleCategory ?? 'patterns', chapter: d.articleChapter }))
        const articleIndex = [...new Map([...usedDocs.filter(d => d.kind === 'article').map(d => articles.find(a => a.id === d.sourceId)!), ...articles].map(a => [a.id, a])).values()].slice(0, 60)
        const captureContext = { ...context, articleIndex, ...(focusArticle && { revisionBase: { ...docForModel(focusArticle), text: focusArticle.text } }), ...(chatSources.size && { chatArchive: { sources: [...chatSources].map(([id, { quote, date }]) => ({ id, quote, date })) } }), memories: usedDocs.slice(0, 12).map(docForModel), ...(archive && { diaryArchive: {
          sources: [...diarySources].map(([id, { quote, date, label }]) => ({ id, quote, date, label })), extractEvents: intent.extractEvents,
        } }), inbox: state.proposals.slice(-12).map(p => ({ kind: p.kind, title: p.title, status: p.status })) }
        const captured = await captureTurn(message, answer.slice(0, 5000), captureContext, older, state.summary, AbortSignal.timeout(75_000))
        const { count, profileChanged, profileUpdates, correctedFocus } = await changeState(db, userId, async (fresh, tx) => {
          const [logged] = await tx.select({ at: rawLogs.createdAt }).from(rawLogs).where(and(eq(rawLogs.id, logId), eq(rawLogs.userId, userId)))
          if (!logged) return { count: 0, profileChanged: 0, profileUpdates: [] as ProfileTurnUpdate[], correctedFocus: undefined as { title: string; correction: string } | undefined }
          const correction = captured.focusedCorrection?.trim()
          let revisionBase: Parameters<typeof addDrafts>[2]['revisionBase']
          let correctedFocus: { title: string; correction: string } | undefined
          if (focus && correction && message.includes(correction) && fresh.focusId === focus.id) {
            const item = fresh.proposals.find(p => p.id === focus.id && (p.status === 'pending' || p.status === 'corrected'))
            if (item) {
              item.status = 'corrected'; item.correction = correction
              correctedFocus = { title: item.title, correction }
              if (focusArticle && item.articleId === focusArticle.sourceId) revisionBase = {
                id: item.articleId, version: articleVersion(focusArticle.at, state.revisions[item.articleId]), correction,
              }
            }
          }
          if (older.length && captured.summary.trim() && fresh.summaryThrough === state.summaryThrough) { fresh.summary = captured.summary; fresh.summaryThrough = through }
          const profileUpdates: ProfileTurnUpdate[] = []
          const profileChanged = intent.extractEvents ? 0 : applyProfileDrafts(fresh, captured.profileUpdates.flatMap(d => {
            const quote = d.quote.trim()
            if (!quote || !message.includes(quote)) return []
            return [{ ...d, evidence: [{ kind: 'chat' as const, id: logId, quote, date: logged.at.toISOString().slice(0, 10) }] }]
          }), { origin: 'chat', at: now(), visible: profile }, profileUpdates)
          const count = addDrafts(fresh, captured.items, { origin: 'chat', logId, chatReplyId: assistantId, message, diarySources, chatSources, diaryOnly: Boolean(archive && intent.extractEvents), articles: (await readArticles(tx, userId, fresh)).filter(a => !a.deleted), revisionBase })
          return { count, profileChanged, profileUpdates, correctedFocus }
        })
        const notice = archive ? !archives.some(item => item.available) ? '没有可查询的日记原文。可在「分析日记」选文件后先保存到资料库。'
          : !diarySources.size ? '没有找到匹配的日记原文，可以换个时间或主题再试。'
          : '本轮查阅了 ' + diarySources.size + ' 段日记原文，未发送整批。' + (intent.extractEvents ? count ? ' 已生成 ' + count + ' 条待核对的事件草稿。' : ' 本轮没有新增可核对的事件草稿。' : '') : undefined
        const unavailable = withoutTools ? '当前 API 不支持模型自主检索。仍可输入「查对话原文：关键词」或说「查日记」，由成我先找相关原文。' : ''
        await emit({ type: 'done', count, profileChanged, ...(profileUpdates.length && { profileUpdates }), ...(correctedFocus && { correctedFocus }), notice: [notice, explicitChat && !explicitChat.excerpts.length ? '没有找到匹配的长期对话原话，可以换个关键词再试。' : '', unavailable].filter(Boolean).join(' ') || undefined })
      } catch { await emit({ type: 'done', warning: '回复已保存。这条消息未能完成自动整理，收件箱和画像没有更新。' }) }
    } catch {
      if (!controller.signal.aborted) await emit({ type: 'error', error: saved ? '回复已保存。' : '这次回复未完成，未写入对话。请重试。' })
    } finally { release(); finishWork() }
  })
})

personalRoute.route('/settings', localSettingsRoute)
personalRoute.route('/profile', profileRoute)

personalRoute.get('/search', async c => {
  const query = c.req.query('q')?.trim()
  if (!query || query.length > 300) throw new WorkspaceError('请输入不超过 300 字的检索词。')
  const db = c.get('db'), userId = c.get('userId')
  const state = await importHistoricalAnalysis(db, userId)
  return c.json(await searchMemory(db, userId, await memoryDocs(db, userId, state), query, c.req.raw.signal, 'memory', true))
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

function upsertContext(state: PersonalState, input: z.infer<typeof contextInput>, id: string | undefined, refs: Evidence[] = []) {
  const contexts = state.contexts ??= []
  const existing = id ? contexts.find(item => item.id === id) : undefined
  if (id && !existing) throw new WorkspaceError('找不到这张人物或环境卡。', 404)
  const eventIds = [...new Set(input.eventIds)]
  for (const eventId of eventIds) requireEvent(state, eventId)
  const links = input.links.map(link => {
    const old = existing && existing.links.find(l => link.id ? l.id === link.id && l.targetId === link.targetId : !l.id && l.targetId === link.targetId)
    for (const eventId of link.eventIds) requireEvent(state, eventId)
    return { ...link, id: old?.id ?? randomUUID(), evidence: old?.evidence }
  })
  if (new Set(links.map(link => link.id)).size !== links.length) throw new WorkspaceError('关系重复。')
  for (const link of links) if (link.targetId === id || !contexts.some(c => c.id === link.targetId)) throw new WorkspaceError('关联对象不存在，或不能关联到自己。')
  const aliases = input.kind === 'person' ? uniqueAliases(input.name, input.aliases ?? existing?.aliases ?? []) : undefined
  const result: LifeContext = { ...input, aliases, id: id ?? randomUUID(), eventIds, links, evidence: combineEvidence(existing ? existing.evidence ?? [] : [], refs), updatedAt: now() }
  if (existing) contexts[contexts.indexOf(existing)] = result
  else contexts.push(result)
  return result
}
const contextReview = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('card'), aliases: aliasesInput, target: key.optional(), kind: z.enum(['person', 'environment']), name: text(160), role: optionalText(200), period: optionalText(120), description: optionalText(5000), eventIds: contextEventIds.default([]) }),
  z.object({ action: z.literal('relation'), fromId: key, toId: key, label: text(160), period: optionalText(120), eventIds: ids }),
])
personalRoute.post('/context-suggestions/:id', async c => {
  const input = await parse(c.req, contextReview)
  return c.json(await changeState(c.get('db'), c.get('userId'), state => {
    const suggestion = state.contextSuggestions?.find(item => item.id === c.req.param('id'))
    if (!suggestion) throw new WorkspaceError('找不到这条建议。', 404)
    if (suggestion.status !== 'pending') throw new WorkspaceError('这条建议已处理。', 409)
    if (input.action === 'dismiss') { suggestion.status = 'dismissed'; return { ok: true } }
    for (const eventId of input.eventIds) requireEvent(state, eventId)
    const cards = state.contexts ??= []
    let id: string
    if (input.action === 'card') {
      if (suggestion.draft.kind === 'relation') throw new WorkspaceError('请按关系审核这条建议。')
      const old = input.target ? cards.find(card => card.id === input.target) : undefined
      if (input.target && (!old || old.kind !== input.kind)) throw new WorkspaceError('找不到同类档案。', 404)
      const sameName = cards.some(card => card.id !== old?.id && matchesContextName(card, input))
      if (sameName && (!old || nameKey(old.name) !== nameKey(input.name))) throw new WorkspaceError('已有档案使用这个名字或别名。请选择补充到哪张档案，或用更明确的代称区分。', 409)
      const { kind, name, aliases, role, period, description, eventIds } = input
      const saved = upsertContext(state, contextInput.parse({ kind, name, aliases, role, period, description, impact: old?.impact, eventIds, links: old?.links }), old?.id, suggestion.evidence)
      id = saved.id
    } else {
      if (suggestion.draft.kind !== 'relation') throw new WorkspaceError('请按档案审核这条建议。')
      const from = cards.find(card => card.id === input.fromId), to = cards.find(card => card.id === input.toId)
      if (!from || !to || from.id === to.id) throw new WorkspaceError('请选择两张不同的已确认档案。')
      const existing = from.links.find(l => l.targetId === to.id && l.label === input.label && (l.period ?? '') === input.period)
      if (!existing && from.links.length >= 24) throw new WorkspaceError('这张档案的关系已达上限。')
      const eventIds = [...new Set([...(existing?.eventIds ?? []), ...input.eventIds])].slice(0, 12)
      const link = { id: existing?.id ?? randomUUID(), targetId: to.id, label: input.label, period: input.period, eventIds, evidence: combineEvidence(existing?.evidence ?? [], suggestion.evidence) }
      from.links = existing ? from.links.map(l => l === existing ? link : l) : [...from.links, link]
      from.updatedAt = now(); id = from.id
    }
    suggestion.status = 'accepted'
    return { id }
  }))
})
personalRoute.post('/contexts', async c => {
  const input = await parse(c.req, contextInput)
  return c.json(await changeState(c.get('db'), c.get('userId'), state => upsertContext(state, input, undefined)), 201)
})
personalRoute.patch('/contexts/:id', async c => {
  const input = await parse(c.req, contextInput)
  return c.json(await changeState(c.get('db'), c.get('userId'), state => upsertContext(state, input, c.req.param('id'))))
})
personalRoute.delete('/contexts/:id', async c => {
  const id = c.req.param('id')
  return c.json(await changeState(c.get('db'), c.get('userId'), state => {
    if (!state.contexts?.some(item => item.id === id)) throw new WorkspaceError('找不到这张人物或环境卡。', 404)
    state.contexts = state.contexts.filter(item => item.id !== id).map(item => ({ ...item, links: item.links.filter(link => link.targetId !== id) }))
    return { id }
  }))
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
    result = await reviewEvents(relevant, correctionsForModel(state, query), article ? { ...docForModel(article), text: article.text } : null, supporting, signal)
  }
  catch { throw new WorkspaceError('跨事件分析未完成，未写入新建议。', 409) }
  const count = await changeState(db, userId, async (fresh, tx) => addDrafts(fresh, result, { origin: 'review', reviewIds: referenceEvents, articleId,
    revisionBase: article && { id: article.sourceId, version: articleVersion(article.at, state.revisions[article.sourceId]) }, articles: (await readArticles(tx, userId, fresh)).filter(a => !a.deleted) }))
  return c.json({ count })
})

const mergeSelection = z.array(key).min(2).max(8).refine(v => new Set(v).size === v.length)
async function mergeSources(db: Parameters<typeof articleHistory>[0], userId: string, state: PersonalState, idList: string[]) {
  return Promise.all(idList.map(async id => {
    const history = await articleHistory(db, userId, state, id)
    const last = history.at(-1)
    if (!last || last.action === 'delete') throw new WorkspaceError('归并材料已变更，请重新选择。', 409)
    return { id, last, versions: history.length }
  }))
}
const mergeMark = (sources: Awaited<ReturnType<typeof mergeSources>>) => hash(sources)
function mergedFields(sources: Awaited<ReturnType<typeof mergeSources>>) {
  const first = sources[0].last
  return { title: first.title, category: first.category, chapter: first.chapter,
    limits: [...new Set(sources.map(s => s.last.limits).filter(Boolean))].join('\n\n'),
    eventIds: [...new Set(sources.flatMap(s => s.last.eventIds))],
    evidence: sources.reduce<Evidence[]>((all, { last }) => combineEvidence(all, last.evidence), []),
  }
}
personalRoute.post('/articles/merge-suggestions', async c => {
  const { chapter } = await parse(c.req, z.object({ chapter: z.enum(articleChapterIds) }))
  const db = c.get('db'), userId = c.get('userId'), state = await getState(db, userId)
  const candidates = (await readArticles(db, userId, state))
    .filter(a => !a.deleted && chapterFor(a).id === chapter)
    .slice(0, 45)
  if (candidates.length < 2) return c.json({ groups: [] })
  const finish = trackLocalRequest()
  try {
    const groups = await suggestDuplicateArticles(candidates, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]))
    return c.json({ groups })
  } catch { throw new WorkspaceError('暂时未能完成相似主题排查，现有百科未改动。', 409) }
  finally { finish() }
})
personalRoute.post('/articles/merge-preview', async c => {
  const { ids } = await parse(c.req, z.object({ ids: mergeSelection }))
  const db = c.get('db'), userId = c.get('userId')
  const sources = await mergeSources(db, userId, await getState(db, userId), ids)
  if (sources.some(s => chapterFor(s.last).id !== chapterFor(sources[0].last).id)) throw new WorkspaceError('先选择同一主题章节内确实有关的条目。')
  const finish = trackLocalRequest()
  try {
    const fact = await draftArticleMerge(sources.map(s => s.last), AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(100_000)]))
    return c.json({ ids, mark: mergeMark(sources), sources, article: { ...mergedFields(sources), fact } })
  } catch { throw new WorkspaceError('未能生成归并预览，旧条目没有改动。', 409) }
  finally { finish() }
})
personalRoute.post('/articles/merge', async c => {
  const input = await parse(c.req, z.object({ ids: mergeSelection, mark: z.string().regex(/^[a-f0-9]{64}$/), title: text(600), fact: text(5000) }))
  const db = c.get('db'), userId = c.get('userId')
  const id = await changeState(db, userId, async (state, tx) => {
    const sources = await mergeSources(tx, userId, state, input.ids)
    if (mergeMark(sources) !== input.mark || sources.some(s => chapterFor(s.last).id !== chapterFor(sources[0].last).id)) throw new WorkspaceError('预览之后有条目发生变化，请重新预览。', 409)
    const [main, ...rest] = sources
    await writeArticle(tx, userId, state, main.id, { ...mergedFields(sources), title: input.title, fact: input.fact }, `归并 ${rest.length} 条：${rest.map(s => s.last.title).join('、')}`, 'edit')
    for (const source of rest) await writeArticle(tx, userId, state, source.id, source.last, `归入「${input.title}」，原版本与观点演变仍可查阅及恢复`, 'delete')
    const archived = new Set(rest.map(s => s.id))
    for (const p of state.proposals) if (p.articleId && archived.has(p.articleId) && p.status !== 'accepted') {
      p.articleId = main.id
      if (p.operation === 'revise') delete p.baseVersion // stale replacement must be redrafted, not appended
    }
    return main.id
  })
  return c.json({ id })
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
    const history = await articleHistory(tx, userId, state, id), last = history.at(-1)
    if (!last || last.action === 'delete') throw new WorkspaceError('找不到可编辑的条目。', 404)
    if (input.version && input.version !== articleVersion(last.at, history)) throw new WorkspaceError('打开编辑后条目已更新，请重新打开，不会覆盖新版。', 409)
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
    if (p.originId?.startsWith('profile:')) throw new WorkspaceError('请在个人画像的长期对话里修订这个判断。', 409)
    if (p.status === 'accepted' || p.status === 'dismissed') throw new WorkspaceError('这条建议已处理。', 409)
    if (input.action === 'correct') { p.status = 'corrected'; p.correction = input.correction; return { id } }
    if (input.action === 'classify') {
      p.kind = input.kind
      return { ok: true }
    }
    if (input.action === 'dismiss') { p.status = 'dismissed'; return { id } }
    if (input.action === 'event') { p.status = 'accepted'; return { id: updateEvent(state, input.event, input.target, p.evidence).id } }
    // Resolve one-click saves against the current directory, not a potentially stale tab.
    if (input.quick && p.kind !== 'article') throw new WorkspaceError('待验证的推测不能直接写成正式百科。', 409)
    const targetId = input.quick
      ? p.articleId ?? input.target ?? findArticleTarget((await readArticles(tx, userId, state)).filter(a => !a.deleted), p)?.id
      : input.target
    if (input.quick && input.target && p.articleId && input.target !== p.articleId) throw new WorkspaceError('这条建议的目标已变更，请刷新后确认。', 409)
    const articleId = targetId ?? randomUUID()
    const history = targetId ? await articleHistory(tx, userId, state, targetId) : [], last = history.at(-1)
    if (targetId && (!last || last.action === 'delete')) throw new WorkspaceError('找不到可修订的条目。', 404)
    const version = last && articleVersion(last.at, history)
    if (p.operation === 'revise' && (!last || targetId !== p.articleId || !p.baseVersion || p.baseVersion !== version)) {
      throw new WorkspaceError('这份修订草稿的底稿已更新，请根据最新版重新生成草稿。旧草稿不会覆盖新版。', 409)
    }
    if (!input.quick && input.article.version && input.article.version !== version) throw new WorkspaceError('打开编辑后条目已更新，请重新打开，不会覆盖新版。', 409)
    const content = p.status === 'corrected' ? p.correction ?? p.content : p.content
    const fields = input.quick ? { ...input.article, title: last?.title ?? p.title, category: (last?.category ?? p.category) as typeof input.article.category,
      chapter: last?.chapter ?? p.chapter, fact: last && p.operation !== 'revise' ? (last.fact.includes(content) ? last.fact : `${last.fact}\n\n${content}`) : content,
      limits: [...new Set([last?.limits, p.counterpoint].filter(Boolean))].join('\n\n'), eventIds: [...new Set([...(last?.eventIds ?? []), ...p.eventIds])],
    } : input.article
    if (fields.fact.length > 5000 || (fields.limits?.length ?? 0) > 5000) throw new WorkspaceError('归入后超出条目长度，请先整理正文，未写入任何修改。', 409)
    const article = attachEvidence(state, fields, combineEvidence(last?.evidence ?? [], p.evidence))
    await writeArticle(tx, userId, state, articleId, article, input.article.reason || (last ? p.operation === 'supplement' ? '确认补充材料' : '确认 AI 修订草稿' : '确认 AI 新建草稿'), last ? 'edit' : 'create')
    p.status = 'accepted'; p.articleId = articleId
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
  const count = await changeState(db, userId, fresh => addDrafts(fresh, result, { origin: 'review', reviewIds: docs.map(d => d.sourceId), articles: [] }))
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
