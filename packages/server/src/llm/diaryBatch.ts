import type { DiaryAnalysisItem, DiaryEntry } from './diarySchemas.js'

// A request budget, not a cap on uploads. Include JSON overhead and split unusually long
// originals with overlap so ordinary quotes at a boundary can still be extracted.
export const GROUP_BUDGET = 20_000
const SEGMENT = 7_000
const OVERLAP = 400
export type AnalysisProgress = { phase: 'read' | 'merge'; completed: number; total: number }
type Part = { source: number; entry: DiaryEntry }
export function diaryGroups(entries: DiaryEntry[]): Part[][] {
  const ordered = entries.map((entry, i) => ({ entry, source: i + 1 }))
    .sort((a, b) => (a.entry.date ?? '9999').localeCompare(b.entry.date ?? '9999') || a.source - b.source)
  const groups: Part[][] = []
  let current: Part[] = [], size = 0
  const push = (part: Part) => {
    const bytes = JSON.stringify(part.entry).length + 25
    if (size + bytes > GROUP_BUDGET && current.length) { groups.push(current); current = []; size = 0 }
    current.push(part); size += bytes
  }
  for (const { entry, source } of ordered) {
    const text = Array.from(entry.content)
    for (let start = 0; start < text.length;) {
      const end = Math.min(start + SEGMENT, text.length)
      const content = text.slice(start, end).join('')
      if (content.trim()) push({ source, entry: { ...entry, content } })
      if (end === text.length) break
      start = end - OVERLAP
    }
  }
  if (current.length) groups.push(current)
  return groups
}

type Results = DiaryAnalysisItem[]
type Run = {
  checkpoints: Record<string, Results>
  save: (id: string, items: Results) => Promise<void>
  progress: (p: AnalysisProgress) => void | Promise<void>
  read: (entries: DiaryEntry[]) => Promise<Results>
  merge: (items: Results) => Promise<Results>
  signal: AbortSignal
}

export async function runDiaryBatch(entries: DiaryEntry[], run: Run): Promise<Results> {
  const groups = diaryGroups(entries)
  const checkpoint = async (key: string, make: () => Promise<Results>) => {
    run.signal.throwIfAborted()
    if (Object.hasOwn(run.checkpoints, key)) return run.checkpoints[key]
    const items = await make()
    run.signal.throwIfAborted()
    await run.save(key, items)
    return items
  }
  const leaves: Results[] = []
  await run.progress({ phase: 'read', completed: groups.filter((_, i) => Object.hasOwn(run.checkpoints, 'read:' + i)).length, total: groups.length })
  for (const [i, group] of groups.entries()) {
    leaves.push(await checkpoint('read:' + i, async () => (await run.read(group.map(p => p.entry))).flatMap(item => {
      if (!item.citations.every(c => group[c.source - 1]?.entry.content.includes(c.quote))) return []
      return [{ ...item, citations: item.citations.map(c => ({ ...c, source: group[c.source - 1].source })) }]
    })))
    if (!Object.hasOwn(run.checkpoints, 'read:' + i)) await run.progress({ phase: 'read', completed: i + 1, total: groups.length })
  }
  // Keep verified context suggestions out of topical merging.
  const contextItems = new Map<string, DiaryAnalysisItem>()
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase()
  for (const item of leaves.flat()) {
    const d = item.contextDraft
    if (!d) continue
    const identity = d.kind === 'relation'
      ? [d.kind, d.from.kind, norm(d.from.name), d.to.kind, norm(d.to.name), norm(d.label), norm(d.period)]
      : [d.kind, norm(d.name), norm(d.period), norm(d.description)]
    const key = JSON.stringify(identity)
    const prev = contextItems.get(key)
    if (!prev) contextItems.set(key, item)
    else contextItems.set(key, { ...prev, citations: [...prev.citations, ...item.citations.filter(c => !prev.citations.some(p => p.source === c.source && p.quote === c.quote))].slice(0, 6) })
  }
  let level = leaves.map(items => items.filter(item => !item.contextDraft)), depth = 0, merged = 0
  const totalMerges = Math.max(0, leaves.length - 1)
  if (totalMerges) await run.progress({ phase: 'merge', completed: 0, total: totalMerges })
  while (level.length > 1) {
    const next: Results[] = []
    for (let i = 0; i < level.length; i += 2) {
      if (!level[i + 1]) { next.push(level[i]); continue }
      const candidates = [...level[i], ...level[i + 1]]
      const result = await checkpoint(`merge:${depth}:${i}`, async () => {
        if (!level[i].length || !level[i + 1].length) return candidates
        return (await run.merge(candidates)).filter(item => !item.contextDraft && item.citations.every(c =>
          candidates.some(candidate => Boolean(candidate.profileDraft) === Boolean(item.profileDraft) && (!item.articleId || candidate.articleId === item.articleId) && (!item.profileDraft || (candidate.profileDraft?.targetId === item.profileDraft.targetId && (item.profileDraft.kind !== 'self' || candidate.profileDraft?.kind === 'self'))) && candidate.citations.some(prev => prev.source === c.source && prev.quote.includes(c.quote)))))
      })
      next.push(result)
      await run.progress({ phase: 'merge', completed: ++merged, total: totalMerges })
    }
    level = next; depth++
  }
  return [...(level[0] ?? []).filter(item => !item.contextDraft), ...contextItems.values()]
}
