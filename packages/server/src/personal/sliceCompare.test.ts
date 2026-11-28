import { expect, it } from 'vitest'
import { compareSlices } from './sliceCompare.js'
import type { PersonalState } from './types.js'

it('compares two environment contexts across events and shared vs unique encyclopedia topics', () => {
  const state: Pick<PersonalState, 'contexts' | 'chapters' | 'events' | 'turningPoints'> = {
    contexts: [
      { id: 'c1', kind: 'context' as never, name: '星桥团队', role: '旧团队', period: '2024', description: '节奏紧凑', impact: '让我学会先看底线', eventIds: ['e1'], links: [], updatedAt: '2024-06-01T00:00:00Z' },
      { id: 'c2', kind: 'context' as never, name: '远山工作室', role: '新团队', period: '2025', description: '自主空间大', impact: '更敢主动协商', eventIds: ['e2'], links: [], updatedAt: '2025-06-01T00:00:00Z' },
    ].map((c, idx) => ({ ...c, kind: 'environment' as const, eventIds: [idx === 0 ? 'e1' : 'e2'] })),
    chapters: [],
    events: [
      { id: 'e1', title: '拒绝长期驻场', date: '2024-05-01', facts: '在星桥团队期间拒绝了固定驻场。', analysis: '', outlook: '想留退出权', evidence: [], updatedAt: '2024-05-02T00:00:00Z' },
      { id: 'e2', title: '主动续约半年', date: '2025-05-01', facts: '在远山工作室主动续约。', analysis: '', outlook: '信任负责人且条款清楚', evidence: [], updatedAt: '2025-05-02T00:00:00Z' },
    ],
    turningPoints: {},
  }
  const articles = [
    { id: 'a1', title: '合作边界与退出权', category: 'values', fact: '在乎退出机制。', eventIds: ['e1', 'e2'], evidence: [], updatedAt: '2025-06-01T00:00:00Z' },
    { id: 'a2', title: '对高强度跟进的疲惫', category: 'patterns', fact: '长期紧盯会耗竭。', eventIds: ['e1'], evidence: [], updatedAt: '2024-06-01T00:00:00Z' },
    { id: 'a3', title: '信任后的主动投入', category: 'relationships', fact: '信任清晰时愿意投入。', eventIds: ['e2'], evidence: [], updatedAt: '2025-06-01T00:00:00Z' },
  ]

  const diff = compareSlices(state, articles, { kind: 'context', id: 'c1' }, { kind: 'context', id: 'c2' })
  expect(diff).not.toBeNull()
  expect(diff!.a.events.map(e => e.id)).toEqual(['e1'])
  expect(diff!.b.events.map(e => e.id)).toEqual(['e2'])
  expect(diff!.sharedArticles.map(a => a.title)).toEqual(['合作边界与退出权'])
  expect(diff!.onlyAArticles.map(a => a.title)).toEqual(['对高强度跟进的疲惫'])
  expect(diff!.onlyBArticles.map(a => a.title)).toEqual(['信任后的主动投入'])
})
