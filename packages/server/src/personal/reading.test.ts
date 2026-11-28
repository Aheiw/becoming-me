import { expect, it } from 'vitest'
import { chapterWeave } from './reading.js'

it('weaves contexts, articles, and turning points into a life book section', () => {
  const events = [{
    id: 'e1', title: '更换团队', date: '2025-02-01', facts: '加入新项目组。', analysis: '',
    evidence: [], updatedAt: '2025-02-02T00:00:00Z',
  }]
  const contexts = [
    { id: 'c1', kind: 'environment' as const, name: '远山团队', role: '新团队', period: '2025', description: '', impact: '', eventIds: ['e1'], links: [{ targetId: 'c2', label: '共事', eventIds: ['e1'] }], updatedAt: '2025-02-02T00:00:00Z' },
    { id: 'c2', kind: 'person' as const, name: '阿禾', role: '搭档', period: '2025', description: '', impact: '', eventIds: [], links: [], updatedAt: '2025-02-02T00:00:00Z' },
  ]
  const articles = [
    { id: 'a1', title: '合作前提', category: 'values', fact: '先对齐节奏。', limits: '仅限长期项目。', eventIds: ['e1'], evidence: [] },
    { id: 'a2', title: '无关旧条目', category: 'values', fact: '无关。', eventIds: ['other'], evidence: [], deleted: false },
  ]
  const turningPoints = {
    a1: [{ id: 'tp1', date: '2025-03', before: '硬扛', after: '先谈条件', why: '看清边界', eventId: 'e1' }],
  }

  const w = chapterWeave(events, contexts, articles, turningPoints)
  expect(w.contexts.map(c => c.card.name)).toEqual(['远山团队', '阿禾'])
  expect(w.articles.map(a => a.id)).toEqual(['a1'])
  expect(w.turningPoints.map(t => t.id)).toEqual(['tp1'])
  expect(w.contextsByEvent.get('e1')?.length).toBe(2)
  expect(w.articlesByEvent.get('e1')?.map(a => a.id)).toEqual(['a1'])
})
