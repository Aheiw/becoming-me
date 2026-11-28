import { and, eq, inArray } from 'drizzle-orm'
import { diaryEntries, interviewDiaryBatches as batches, personalVectors } from '../db/schema.js'
import type { Db } from '../types.js'
import { changeState, hash } from './store.js'
import type { Evidence } from './types.js'

// Remove an archived source and drafts that depend on it, not anything already confirmed.
export function removeDiaryBatch(db: Db, userId: string, batchId: string) {
  return changeState(db, userId, async (state, tx) => {
    const owned = and(eq(batches.userId, userId), eq(batches.id, batchId))
    const [batch] = await tx.select({ entries: batches.entries }).from(batches).where(owned).for('update')
    if (!batch) return null
    const refers = (e: Evidence) => e.kind === 'diary' && e.id === batchId
    const report = state.profileReport
    const affected = new Set<string>()
    if (report) {
      const legacyAffected = report.diaryBatchIds?.includes(batchId) ?? (report.coverage.diaries > 0)
      report.findings = report.findings.filter(f => {
        if (f.evidence.some(refers) || (!f.updatedAt && legacyAffected)) { affected.add(`profile:${report.id}:${f.id}`); return false }
        if (f.history) f.history = f.history.filter(r => !r.evidence.some(refers))
        return true
      })
      if (report.diaryBatchIds) report.diaryBatchIds = report.diaryBatchIds.filter(id => id !== batchId)
      if (!report.findings.length) delete state.profileReport
    }
    const removed = state.proposals.filter(p => (p.status === 'pending' && (p.originId === batchId || p.evidence.some(refers))) ||
      (p.originId?.startsWith('profile:') && (p.evidence.some(refers) || affected.has(p.originId))))
    const keep = new Set(removed.map(p => p.id))
    state.proposals = state.proposals.filter(p => !keep.has(p.id))
    const contextCount = state.contextSuggestions?.length ?? 0
    if (state.contextSuggestions) state.contextSuggestions = state.contextSuggestions.filter(s => s.status !== 'pending' || s.originId !== batchId)
    if (state.diaryJobs) delete state.diaryJobs[batchId]
    state.diarySeen = state.diarySeen.filter(id => id !== batchId)
    if (state.diaryFocusId === batchId) delete state.diaryFocusId
    if (state.focusId && keep.has(state.focusId)) delete state.focusId
    for (const [turn, sources] of Object.entries(state.chatEvidence ?? {})) {
      const remaining = sources.filter(e => !refers(e))
      if (remaining.length) state.chatEvidence![turn] = remaining
      else delete state.chatEvidence![turn]
    }

    // Raw-document vector keys are content-addressed; keep a key if another saved source still uses it.
    const sourceKey = (date: string | null, content: string) => hash([date, content.trim()])
    const oldKeys = new Set(batch.entries.map(e => sourceKey(e.date, e.content)))
    await tx.delete(batches).where(owned)
    const others = await tx.select({ entries: batches.entries }).from(batches).where(eq(batches.userId, userId))
    for (const row of others) for (const e of row.entries) oldKeys.delete(sourceKey(e.date, e.content))
    const legacy = await tx.select({ date: diaryEntries.entryDate, content: diaryEntries.content }).from(diaryEntries).where(eq(diaryEntries.userId, userId))
    for (const e of legacy) oldKeys.delete(sourceKey(e.date, e.content))
    const proposalVectors = new Set(state.proposals.filter(p => p.originId === batchId || p.evidence.some(refers)).concat(removed).map(p => `日记分析-${p.id}`))
    const cached = await tx.select({ id: personalVectors.documentId }).from(personalVectors).where(eq(personalVectors.userId, userId))
    const stale = cached.map(v => v.id).filter(id => proposalVectors.has(id) || (id.startsWith('日记原文-') && oldKeys.has(id.split('-')[1])))
    const deletedVectors = stale.length ? await tx.delete(personalVectors).where(and(eq(personalVectors.userId, userId), inArray(personalVectors.documentId, stale))).returning({ id: personalVectors.documentId }) : []
    return {
      entries: batch.entries.length, vectors: deletedVectors.length,
      suggestions: removed.length + contextCount - (state.contextSuggestions?.length ?? 0),
      retained: {
        events: state.events.filter(e => e.evidence.some(refers)).length,
        articles: Object.values(state.revisions).filter(history => history.some(rev => rev.evidence.some(refers))).length,
        contexts: (state.contexts ?? []).filter(c => c.evidence?.some(refers) || c.links.some(l => l.evidence?.some(refers))).length,
      },
    }
  })
}
