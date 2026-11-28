import { findArticleTarget, type ArticleTarget } from './articleTopics.js'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { diaryEntries, diaryFactEvidences, factEvidences, interviewDiaryBatches as batches, personalWorkspaces, rawLogs, sessions, structuredFacts } from '../db/schema.js'
import type { StructuredFactCategory } from '../db/schema.js'
import type { Db } from '../types.js'
import { citationsMatch, type DiaryAnalysisItem, type DiaryEntry } from '../llm/diarySchemas.js'
import { applyProfileDrafts, type profileContext } from './profile.js'
import { emptyPersonalState, type Article, type Evidence, type PersonalState, type Proposal, type Revision } from './types.js'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Store = Db | Tx
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const personalSession = (userId: string) => `personal-${hash(userId).slice(0, 32)}`
export const now = () => new Date().toISOString()
export class WorkspaceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}
export const ownedFact = (userId: string, id: string) => and(eq(structuredFacts.userId, userId), eq(structuredFacts.id, id))
export async function getState(db: Store, userId: string) {
  const [row] = await db.select({ state: personalWorkspaces.state }).from(personalWorkspaces).where(eq(personalWorkspaces.userId, userId))
  return row?.state ?? emptyPersonalState()
}
export async function changeState<T>(db: Db, userId: string, change: (state: PersonalState, tx: Tx) => Promise<T> | T) {
  return db.transaction(async tx => {
    await tx.insert(personalWorkspaces).values({ userId, state: emptyPersonalState() }).onConflictDoNothing()
    const [row] = await tx.select({ state: personalWorkspaces.state }).from(personalWorkspaces).where(eq(personalWorkspaces.userId, userId)).for('update')
    const result = await change(row.state, tx)
    await tx.update(personalWorkspaces).set({ state: row.state }).where(eq(personalWorkspaces.userId, userId))
    return result
  })
}
export async function getChat(db: Store, userId: string, count?: number) {
  const query = db.select({ id: rawLogs.id, role: rawLogs.role, content: rawLogs.content, createdAt: rawLogs.createdAt })
    .from(rawLogs).where(and(eq(rawLogs.userId, userId), eq(rawLogs.sessionId, personalSession(userId)), inArray(rawLogs.role, ['user', 'assistant'])))
  if (count) return (await query.orderBy(desc(rawLogs.createdAt), desc(rawLogs.id)).limit(count)).reverse()
  return query.orderBy(asc(rawLogs.createdAt), asc(rawLogs.id))
}
export async function saveTurn(db: Db, userId: string, question: string, answer: string, evidence: Evidence[], dreamId?: string, offerDream = false) {
  const id = randomUUID()
  const sessionId = personalSession(userId)
  const assistantId = randomUUID()
  await changeState(db, userId, async (state, tx) => {
    await tx.insert(sessions).values({ id: sessionId, userId, type: 'regular', status: 'active' }).onConflictDoNothing()
    const [last] = await getChat(tx, userId, 1)
    const at = Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)
    await tx.insert(rawLogs).values([
      { id, userId, sessionId, role: 'user', content: question, createdAt: new Date(at) },
      { id: assistantId, userId, sessionId, role: 'assistant', content: answer, createdAt: new Date(at + 1) },
    ])
    if (evidence.length) (state.chatEvidence ??= {})[assistantId] = evidence
    if (dreamId || offerDream) (state.privateTurns ??= []).push(id, assistantId)
    if (dreamId) {
      const dreams = (state.dreamTurns ??= {})
      dreams[id] = dreams[assistantId] = dreamId
    }
    if (offerDream) (state.dreamDrafts ??= {})[assistantId] = { userId: id }
  })
  return { id, assistantId }
}

function seedDiary(state: PersonalState, id: string, entries: DiaryEntry[], analysis: DiaryAnalysisItem[], createdAt: string, withEvents = false, articles: ArticleTarget[] = []) {
  if (state.diarySeen.includes(id)) return
  state.diarySeen.push(id)
  for (const item of analysis) {
    if (item.profileDraft || !citationsMatch(entries, item)) continue
    if (item.contextDraft) {
      (state.contextSuggestions ??= []).push({ id: randomUUID(), originId: id, draft: item.contextDraft, basis: item.basis, status: 'pending',
        evidence: item.citations.map(({ source, quote }) => ({ kind: 'diary', id, index: source - 1, quote, date: entries[source - 1].date, label: entries[source - 1].filename ?? undefined })) })
      continue
    }
    const kind = withEvents && item.category === 'life_events' ? 'event' : item.hypothesis ? 'question' : 'article'
    const target = kind === 'event' ? undefined : findArticleTarget(articles, { ...item, title: item.title ?? item.fact })
    const pending = state.proposals.find(p => p.status === 'pending' && p.kind === kind && p.content === item.fact && kind !== 'event' && p.articleId === target?.id && p.title === (item.title?.trim() || item.fact))
    const evidence: Evidence[] = item.citations.map(({ source, quote }) => ({ kind: 'diary', id, index: source - 1, quote, date: entries[source - 1].date, label: entries[source - 1].filename ?? undefined }))
    if (pending) { pending.evidence = combineEvidence(pending.evidence, evidence); continue }
    if (kind === 'question' && state.proposals.some(p => p.kind === 'question' && !p.originId?.startsWith('profile:') && (p.status === 'corrected' || p.status === 'dismissed') && (p.content === item.fact || p.title === item.title))) continue
    state.proposals.push({ id: randomUUID(), kind, title: item.title?.trim() || item.fact, content: item.fact, basis: item.basis,
      eventDraft: withEvents && item.category === 'life_events' ? item.eventDraft ?? undefined : undefined,
      counterpoint: item.counterpoint ?? '', category: target?.category ?? item.category, chapter: target?.chapter ?? item.chapter ?? undefined, articleId: target?.id, operation: kind === 'article' && target ? 'supplement' : undefined, eventIds: [], origin: 'diary', originId: id, status: 'pending', createdAt,
      evidence,
    })
  }
}
export async function archiveDiaries(db: Db, userId: string, entries: DiaryEntry[], origin: 'import' | 'journal' = 'import') {
  const id = hash([userId, origin, entries])
  await db.insert(batches).values({ id, userId, entries, origin }).onConflictDoNothing()
  return id
}
export async function storeDiaryAnalysis(db: Db, userId: string, id: string, analysis: DiaryAnalysisItem[], profile?: ReturnType<typeof profileContext>) {
  return changeState(db, userId, async (state, tx) => {
    const scope = and(eq(batches.id, id), eq(batches.userId, userId))
    const [row] = await tx.select().from(batches).where(scope).for('update')
    if (!row) throw new WorkspaceError('日记原件已删除，无法写入分析。', 404)
    if (!row.analysis) await tx.update(batches).set({ analysis }).where(scope)
    const saved = row.analysis ?? analysis
    seedDiary(state, id, row.entries, saved, row.createdAt.toISOString(), !row.analysis, (await readArticles(tx, userId, state)).filter(a => !a.deleted))
    const profileChanged = !row.analysis && profile ? applyProfileDrafts(state, saved.flatMap(item => {
      const d = item.profileDraft
      if (!d || (d.kind !== 'self' && d.kind !== 'observation') || !citationsMatch(row.entries, item)) return []
      return [{ ...d, title: item.title?.trim() || item.fact, observation: item.fact, reason: item.basis,
        evidence: item.citations.map(({ source, quote }) => ({ kind: 'diary' as const, id, index: source - 1, quote,
          date: row.entries[source - 1].date, label: row.entries[source - 1].filename ?? undefined })) }]
    }), { origin: 'diary', at: now(), visible: profile }) : 0
    if (state.diaryJobs) delete state.diaryJobs[id]
    return { suggestions: saved.filter(item => !item.profileDraft), profileChanged }
  })
}
export async function importHistoricalAnalysis(db: Db, userId: string) {
  const state = await getState(db, userId)
  const ids = await db.select({ id: batches.id }).from(batches).where(and(eq(batches.userId, userId), isNotNull(batches.analysis)))
  const missing = ids.filter(x => !state.diarySeen.includes(x.id)).map(x => x.id)
  if (!missing.length) return state
  // Only fetch these entries locally; never forward an old batch for analysis again.
  return changeState(db, userId, async (fresh, tx) => {
    const rows = await tx.select().from(batches).where(and(eq(batches.userId, userId), inArray(batches.id, missing)))
    const articles = (await readArticles(tx, userId, fresh)).filter(a => !a.deleted)
    for (const row of rows) if (row.analysis) seedDiary(fresh, row.id, row.entries, row.analysis, row.createdAt.toISOString(), false, articles)
    return fresh
  })
}

export const articleVersion = (at: string, revisions?: Revision[]) => `${at}:${revisions?.length || 1}`

export async function readArticles(db: Store, userId: string, state: PersonalState) {
  const rows = await db.select().from(structuredFacts).where(eq(structuredFacts.userId, userId)).orderBy(desc(structuredFacts.updatedAt))
  const current: (Article & { id: string; updatedAt: string; deleted: boolean; version: string })[] = rows.map(row => {
    const last = state.revisions[row.id]?.at(-1)
    return { id: row.id, title: last?.title ?? row.fact, category: row.category, chapter: last?.chapter, fact: row.fact, limits: last?.limits, eventIds: last?.eventIds ?? [], evidence: last?.evidence ?? [], updatedAt: row.updatedAt.toISOString(), deleted: false, version: articleVersion(row.updatedAt.toISOString(), state.revisions[row.id]) }
  })
  for (const [id, history] of Object.entries(state.revisions)) {
    const last = history.at(-1)
    if (last?.action === 'delete') current.push({ id, ...last, updatedAt: last.at, deleted: true, version: articleVersion(last.at, history) })
  }
  return current
}
export async function articleHistory(db: Store, userId: string, state: PersonalState, id: string): Promise<Revision[]> {
  if (state.revisions[id]?.length) return state.revisions[id]
  const [row] = await db.select().from(structuredFacts).where(ownedFact(userId, id))
  if (!row) return []
  const [diary, chat] = await Promise.all([
    db.select({ kindId: diaryEntries.id, date: diaryEntries.entryDate, label: diaryEntries.filename, quote: diaryFactEvidences.quote })
      .from(diaryFactEvidences).innerJoin(diaryEntries, eq(diaryFactEvidences.diaryId, diaryEntries.id))
      .where(and(eq(diaryFactEvidences.factId, id), eq(diaryEntries.userId, userId))).orderBy(asc(diaryFactEvidences.ordinal)),
    db.select({ id: rawLogs.id, content: rawLogs.content, date: rawLogs.createdAt }).from(factEvidences).innerJoin(rawLogs, eq(factEvidences.logId, rawLogs.id))
      .where(and(eq(factEvidences.factId, id), eq(rawLogs.userId, userId), eq(rawLogs.role, 'user'))),
  ])
  return [{ at: row.updatedAt.toISOString(), action: 'baseline', reason: '升级前保存的条目', title: row.fact, fact: row.fact, category: row.category, eventIds: [],
    evidence: [...diary.map(({ kindId, label, ...item }): Evidence => ({ kind: 'saved-diary', id: kindId, label: label ?? undefined, ...item })),
      ...chat.map(item => ({ kind: 'chat' as const, id: item.id, quote: item.content.slice(0, 600), date: item.date.toISOString().slice(0, 10) }))] }]
}
export async function writeArticle(tx: Tx, userId: string, state: PersonalState, id: string, input: Article, reason: string, action: Revision['action']) {
  const history = await articleHistory(tx, userId, state, id)
  const at = now()
  state.revisions[id] = [...history, { title: input.title, category: input.category, chapter: input.chapter, fact: input.fact, limits: input.limits, eventIds: input.eventIds, evidence: input.evidence, at, action, reason }]
  if (action === 'delete') {
    await tx.delete(structuredFacts).where(ownedFact(userId, id))
  } else {
    const values = { category: input.category as StructuredFactCategory, fact: input.fact, updatedAt: new Date(at) }
    await tx.insert(structuredFacts).values({ ...values, id, userId, source: 'interview' })
      .onConflictDoUpdate({ target: structuredFacts.id, set: values, setWhere: eq(structuredFacts.userId, userId) })
    // Rebuild the old projection for export/legacy views; the complete source list lives in the revision.
    const legacyDiary = input.evidence.filter(e => e.kind === 'saved-diary')
    const legacyChat = [...new Set(input.evidence.filter(e => e.kind === 'chat').map(e => e.id))]
    await tx.delete(diaryFactEvidences).where(eq(diaryFactEvidences.factId, id))
    await tx.delete(factEvidences).where(eq(factEvidences.factId, id))
    if (legacyDiary.length) {
      const available = await tx.select({ id: diaryEntries.id }).from(diaryEntries).where(and(eq(diaryEntries.userId, userId), inArray(diaryEntries.id, legacyDiary.map(e => e.id))))
      const valid = legacyDiary.filter(e => available.some(row => row.id === e.id))
      if (valid.length) await tx.insert(diaryFactEvidences).values(valid.map((e, ordinal) => ({ factId: id, ordinal, diaryId: e.id, quote: e.quote })))
    }
    if (legacyChat.length) {
      const available = await tx.select({ id: rawLogs.id }).from(rawLogs).where(and(eq(rawLogs.userId, userId), inArray(rawLogs.id, legacyChat)))
      if (available.length) await tx.insert(factEvidences).values(available.map(({ id: logId }) => ({ factId: id, logId })))
    }
  }
}

export function combineEvidence(first: Evidence[], second: Evidence[]) {
  const entries = new Map<string, Evidence>()
  for (const item of [...first, ...second]) entries.set(JSON.stringify([item.kind, item.id, item.index, item.quote]), item)
  return [...entries.values()]
}
