import { indexEventContexts } from './contextEvents.js'
import type { Article, Chapter, EventImportance, LifeContext, LifeEvent, TurningPoint } from './types.js'

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

export type BookArticle = Article & { id: string; deleted?: boolean; updatedAt?: string }

export function chapterWeave(
  sectionEvents: LifeEvent[],
  contexts: LifeContext[],
  articles: BookArticle[],
  turningPoints: Record<string, TurningPoint[]>,
) {
  const eventIds = new Set(sectionEvents.map(e => e.id))
  const eventContexts = indexEventContexts(contexts)
  const contextMap = new Map<string, { card: LifeContext; count: number; directCount: number }>()
  const contextsByEvent = new Map<string, { card: LifeContext; direct: boolean }[]>()

  for (const event of sectionEvents) {
    const linked = [...(eventContexts.get(event.id)?.values() ?? [])]
    contextsByEvent.set(event.id, linked)
    for (const { card, direct } of linked) {
      const prev = contextMap.get(card.id)
      if (prev) {
        prev.count++
        if (direct) prev.directCount++
      } else {
        contextMap.set(card.id, { card, count: 1, directCount: direct ? 1 : 0 })
      }
    }
  }

  const sectionContexts = [...contextMap.values()]
    .sort((a, b) => b.count - a.count || b.directCount - a.directCount || a.card.name.localeCompare(b.card.name, 'zh-CN'))

  const sectionArticles = articles.filter(a => !a.deleted && a.eventIds.some(id => eventIds.has(id)))
  const articlesByEvent = new Map<string, BookArticle[]>()
  for (const article of sectionArticles) {
    for (const eid of article.eventIds) {
      if (!eventIds.has(eid)) continue
      const list = articlesByEvent.get(eid) ?? []
      list.push(article)
      articlesByEvent.set(eid, list)
    }
  }

  const allTurns = Object.values(turningPoints).flat()
  const turnsById = new Map<string, TurningPoint>()
  for (const tp of allTurns) {
    if ((tp.eventId && eventIds.has(tp.eventId)) || sectionArticles.some(a => turningPoints[a.id]?.some(x => x.id === tp.id))) {
      turnsById.set(tp.id, tp)
    }
  }
  for (const eid of eventIds) {
    for (const tp of turningPoints[eid] ?? []) turnsById.set(tp.id, tp)
  }

  const turnsByEvent = new Map<string, TurningPoint[]>()
  for (const tp of turnsById.values()) {
    if (!tp.eventId) continue
    const list = turnsByEvent.get(tp.eventId) ?? []
    list.push(tp)
    turnsByEvent.set(tp.eventId, list)
  }

  return {
    contexts: sectionContexts,
    articles: sectionArticles,
    turningPoints: [...turnsById.values()].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')),
    contextsByEvent,
    articlesByEvent,
    turnsByEvent,
  }
}
