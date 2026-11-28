import { expect, it } from 'vitest'
import { groupArticleProposals } from './inboxGroups.js'
import { findQuoteRange } from '../../../web/src/lib/quoteMatch.js'
import type { Proposal } from './types.js'

const baseProposal = (id: string, overrides: Partial<Proposal>): Proposal => ({
  id,
  kind: 'article',
  title: '合作边界',
  content: '内容',
  basis: '依据',
  counterpoint: '',
  category: 'values',
  eventIds: [],
  evidence: [],
  origin: 'diary',
  status: 'pending',
  createdAt: '2026-11-28T00:00:00Z',
  ...overrides,
})

it('groups proposals targeting the same existing article or normalized new title', () => {
  const articles = [{ id: 'a1', title: '合作边界与退出权', category: 'values' }]
  const proposals: Proposal[] = [
    baseProposal('p1', { articleId: 'a1', title: '合作前提', content: '希望保留退出条款。' }),
    baseProposal('p2', { title: '合作边界与退出权', content: '签约前先确认变更流程。' }),
    baseProposal('p3', { title: '作息节奏', content: '早睡更稳。', category: 'patterns' }),
    baseProposal('p4', { title: '作息·节奏', content: '早上效率高。', category: 'patterns' }),
    baseProposal('p5', { articleId: 'a1', operation: 'revise', title: '修订版本', content: '整篇修订不参与批量追加。' }),
  ]

  const groups = groupArticleProposals(proposals, articles)
  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({ targetArticleId: 'a1', title: '合作边界与退出权' })
  expect(groups[0].items.map(i => i.id)).toEqual(['p1', 'p2'])
  expect(groups[1]).toMatchObject({ title: '作息节奏' })
  expect(groups[1].items.map(i => i.id)).toEqual(['p3', 'p4'])
})

it('locates quotes in original text even across CRLF or wrapped spaces', () => {
  const original = '第一段背景。\r\n\r\n那天我决定：\r\n先保留退出空间，  再谈后续合作。\r\n\r\n第三段结尾。'
  const range = findQuoteRange(original, '先保留退出空间， 再谈后续合作。')
  expect(range).not.toBeNull()
  expect(original.slice(range!.start, range!.end)).toBe('先保留退出空间，  再谈后续合作。')
})
