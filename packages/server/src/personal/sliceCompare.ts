import { indexEventContexts } from './contextEvents.js'
import type { Article, Chapter, ComparisonSlice, LifeContext, LifeEvent, PersonalState, TurningPoint } from './types.js'

export type ArticleSummary = Article & { id: string; deleted?: boolean; updatedAt: string }

export type SliceSnapshot = {
  slice: ComparisonSlice
  title: string
  subtitle: string
  summary: string
  events: LifeEvent[]
  articles: ArticleSummary[]
  turningPoints: TurningPoint[]
}

const byChronology = (a: LifeEvent, b: LifeEvent) =>
  (a.date || '9999').localeCompare(b.date || '9999') || a.updatedAt.localeCompare(b.updatedAt)

export function buildSliceSnapshot(
  state: Pick<PersonalState, 'contexts' | 'chapters' | 'events' | 'turningPoints'>,
  articles: ArticleSummary[],
  slice: ComparisonSlice,
): SliceSnapshot | null {
  let title = ''
  let subtitle = ''
  let summary = ''
  let events: LifeEvent[] = []

  if (slice.kind === 'context') {
    const card: LifeContext | undefined = state.contexts?.find(c => c.id === slice.id)
    if (!card) return null
    const eventContexts = indexEventContexts(state.contexts ?? [])
    title = card.name
    subtitle = [card.kind === 'person' ? '人物' : '环境', card.role, card.period].filter(Boolean).join(' · ')
    summary = [card.description, card.impact && `记下的影响：${card.impact}`].filter(Boolean).join('\n')
    events = state.events.filter(e => eventContexts.get(e.id)?.has(card.id)).sort(byChronology)
  } else {
    const chapter: Chapter | undefined = state.chapters?.find(c => c.id === slice.id)
    if (!chapter) return null
    title = chapter.title
    subtitle = '人生阶段'
    summary = chapter.introduction
    events = state.events.filter(e => e.chapterId === chapter.id).sort(byChronology)
  }

  const eventIds = new Set(events.map(e => e.id))
  const relatedArticles = articles.filter(a => !a.deleted && a.eventIds.some(id => eventIds.has(id)))
  const turningPoints = events.flatMap(e => state.turningPoints?.[e.id] ?? [])

  return { slice, title, subtitle, summary, events, articles: relatedArticles, turningPoints }
}

export function compareSlices(
  state: Pick<PersonalState, 'contexts' | 'chapters' | 'events' | 'turningPoints'>,
  articles: ArticleSummary[],
  sliceA: ComparisonSlice,
  sliceB: ComparisonSlice,
) {
  const a = buildSliceSnapshot(state, articles, sliceA)
  const b = buildSliceSnapshot(state, articles, sliceB)
  if (!a || !b) return null
  const idsA = new Set(a.articles.map(x => x.id))
  const idsB = new Set(b.articles.map(x => x.id))
  const sharedArticles = a.articles.filter(x => idsB.has(x.id))
  const onlyAArticles = a.articles.filter(x => !idsB.has(x.id))
  const onlyBArticles = b.articles.filter(x => !idsA.has(x.id))
  return { a, b, sharedArticles, onlyAArticles, onlyBArticles }
}
