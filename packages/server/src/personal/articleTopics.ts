// Reading chapters over the existing storage categories; no archive migration.
export const articleChapters = [
  { id: 'growth', name: '成长与环境', categories: ['childhood', 'education', 'life_events'] },
  { id: 'rhythm', name: '身体与生活节奏', categories: [] },
  { id: 'self', name: '自我看法', categories: ['character', 'fears'] },
  { id: 'work', name: '能力与工作方式', categories: ['career', 'skills'] },
  { id: 'relationships', name: '关系与边界', categories: ['relationships'] },
  { id: 'values', name: '价值观与偏好', categories: ['values', 'preferences', 'opinions', 'goals'] },
  { id: 'decisions', name: '决策与行为习惯', categories: ['patterns'] },
] as const
export const articleChapterIds = ['growth', 'rhythm', 'self', 'work', 'relationships', 'values', 'decisions'] as const
export type ArticleChapterId = typeof articleChapterIds[number]
export type ArticleTarget = { id: string; title: string; category: string; chapter?: ArticleChapterId }
export function chapterFor(item: { category: string; chapter?: ArticleChapterId | null }) {
  return articleChapters.find(c => c.id === item.chapter) ?? articleChapters.find(c => (c.categories as readonly string[]).includes(item.category)) ?? articleChapters[2]
}
const titleKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
export function findArticleTarget(articles: ArticleTarget[], item: { articleId?: string | null; title: string; category: string; chapter?: ArticleChapterId | null }) {
  if (item.articleId) return articles.find(a => a.id === item.articleId)
  const title = titleKey(item.title)
  if (!title) return
  const matches = articles.filter(a => titleKey(a.title) === title)
  if (matches.length === 1) return matches[0]
  const sameChapter = matches.filter(a => chapterFor(a).id === chapterFor(item).id)
  return sameChapter.length === 1 ? sameChapter[0] : undefined
}
