import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPersonalState, type PersonalState } from './types.js'
import { createMockDb, createTestApp, req } from '../test/helpers.js'

let memoryState: PersonalState = emptyPersonalState()

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>()
  return {
    ...actual,
    getState: vi.fn(async () => memoryState),
    importHistoricalAnalysis: vi.fn(async () => memoryState),
    readArticles: vi.fn(async () => []),
    changeState: vi.fn(async (_db: unknown, _userId: string, mutate: (s: PersonalState, tx: unknown) => unknown) => {
      return await mutate(memoryState, {})
    }),
  }
})

import { personalRoute } from '../routes/personal.js'

describe('personal experiments', () => {
  beforeEach(() => {
    memoryState = emptyPersonalState()
  })

  it('creates, updates, and deletes a low-cost self-experiment', async () => {
    const app = createTestApp(personalRoute, '/api/personal', createMockDb())

    const createRes = await req(app, 'POST', '/api/personal/experiments', {
      title: '合作前明确退出条件',
      hypothesis: '我在意的是退出空间而不是怕长期承诺',
      action: '下一次谈判先口头试探退出机制',
      reviewDate: '2026-12-10',
    })
    expect(createRes.status).toBe(201)
    const expId = createRes.body.id
    expect(createRes.body.status).toBe('active')

    const stateRes = await req(app, 'GET', '/api/personal')
    expect(stateRes.status).toBe(200)
    expect(stateRes.body.experiments).toHaveLength(1)

    const patchRes = await req(app, 'PATCH', `/api/personal/experiments/${expId}`, {
      status: 'validated',
      outcome: '对方同意写入季度回顾后，我反而愿意签一年。',
      reflection: '确实是看重退出权，而不是抗拒长期做事。',
    })
    expect(patchRes.status).toBe(200)
    expect(patchRes.body.status).toBe('validated')

    const delRes = await req(app, 'DELETE', `/api/personal/experiments/${expId}`)
    expect(delRes.status).toBe(200)

    const afterDel = await req(app, 'GET', '/api/personal')
    expect(afterDel.body.experiments).toHaveLength(0)
  })
})
