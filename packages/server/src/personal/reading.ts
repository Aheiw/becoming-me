import type { Chapter, EventImportance, LifeEvent, TurningPoint } from './types.js'

export const importanceLabel: Record<EventImportance, string> = { regular: '普通事件', milestone: '人生大事', turning: '人生转折' }
export const turningEvents = (points: Record<string, TurningPoint[]>) => new Set(Object.values(points).flat().flatMap(p => p.eventId ? [p.eventId] : []))
export const eventImportance = (event: LifeEvent, turns: ReadonlySet<string>) => event.importance ?? (turns.has(event.id) ? 'turning' : 'regular')
export const hasTopics = (event: LifeEvent, topics: readonly string[]) => topics.every(topic => event.topics?.includes(topic))
export const compareEventDate = (a: LifeEvent, b: LifeEvent) => Number(Boolean(b.date)) - Number(Boolean(a.date)) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'zh-CN')

export function bookSections(events: LifeEvent[], chapters: Chapter[]) {
  const dated = [...events].sort(compareEventDate)
  const chapterIds = new Set(chapters.map(ch => ch.id))
  const byYear = new Map<string, LifeEvent[]>()
  const byChapter = new Map<string, LifeEvent[]>()
  for (const event of dated) {
    const [groups, key] = event.chapterId && chapterIds.has(event.chapterId)
      ? [byChapter, event.chapterId] : [byYear, event.date.slice(0, 4)]
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(event)
  }
  return [
    ...[...chapters].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN')).map(ch => ({ id: ch.id, title: ch.title, introduction: ch.introduction, events: byChapter.get(ch.id) ?? [] })),
    ...Array.from(byYear, ([year, events]) => ({ id: `year-${year || 'unknown'}`, title: year ? `${year} 年 · 未分章` : '时间未定 · 未分章', introduction: '', events })),
  ]
}
