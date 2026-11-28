import { chapterFor, findArticleTarget, type ArticleTarget } from './articleTopics.js'
import type { Proposal } from './types.js'

const titleKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')

export type ProposalThemeGroup = {
  key: string
  targetArticleId?: string
  title: string
  chapterId: string
  items: Proposal[]
}

export function groupArticleProposals(proposals: Proposal[], activeArticles: ArticleTarget[]): ProposalThemeGroup[] {
  const buckets = new Map<string, ProposalThemeGroup>()

  for (const p of proposals) {
    if ((p.status !== 'pending' && p.status !== 'corrected') || p.originId?.startsWith('profile:')) continue
    if (p.kind !== 'article' || p.operation === 'revise') continue
    const target = findArticleTarget(activeArticles, p)
    const chapter = chapterFor(target ?? p)
    const key = target
      ? `article:${target.id}`
      : `title:${chapter.id}:${titleKey(p.title)}`
    if (!target && !titleKey(p.title)) continue

    const existing = buckets.get(key)
    if (existing) {
      existing.items.push(p)
    } else {
      buckets.set(key, {
        key,
        ...(target && { targetArticleId: target.id }),
        title: target?.title ?? p.title,
        chapterId: chapter.id,
        items: [p],
      })
    }
  }

  return [...buckets.values()].filter(g => g.items.length >= 2)
}
