import { expect, it } from 'vitest'
import { applyProfileDrafts, type ProfileTurnUpdate } from './profile.js'
import { emptyPersonalState } from './types.js'

it('records updated profile findings in changedOut for immediate turn feedback', () => {
  const state = emptyPersonalState()
  const updates: ProfileTurnUpdate[] = []
  const count = applyProfileDrafts(state, [{
    targetId: null,
    theme: 'values',
    kind: 'self',
    title: '看重退出空间',
    observation: '在决定合作时，需要先确认能够退出。',
    limits: '当负责人可信时也会主动续约。',
    question: '除了退出权，还有哪些条件让你愿意长期合作？',
    reason: '根据本人在长期对话中的明确自述。',
    evidence: [{ kind: 'chat', id: 'm1', quote: '我想保留退出的自由。', date: '2026-11-28' }],
  }], { origin: 'chat', at: '2026-11-28T10:00:00Z', visible: [] }, updates)

  expect(count).toBe(1)
  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({
    title: '看重退出空间',
    status: 'self',
    observation: '在决定合作时，需要先确认能够退出。',
    reason: '根据本人在长期对话中的明确自述。',
  })
})
