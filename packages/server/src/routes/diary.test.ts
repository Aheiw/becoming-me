import { APICallError } from 'ai'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diaryRoute } from './diary.js'
import { analyzeDiaries } from '../llm/diary.js'
import { diaryEntries, diaryFactEvidences, diarySavedBatches, structuredFacts } from '../db/schema.js'
import { createMockDb, createTestApp, req } from '../test/helpers.js'

vi.mock('../llm/diary.js', () => ({ analyzeDiaries: vi.fn() }))

const entries = [
  { date: '2026-11-22', filename: 'newer.md', content: '  这次我宁愿少赚一点，也想自己决定怎么做。\n随后我和朋友联系。  ' },
  { date: '2026-10-15', filename: 'earlier.txt', content: '涉及生活开支的时候，收入得先有保障。' },
  { date: '2026-10-10', filename: null, content: '今天出门买了杯咖啡。' },
]
const suggestion = {
  category: 'preferences' as const, fact: '愿为自主权让出部分收入，但会先顾及生活开支。',
  citations: [
    { source: 1, quote: '我宁愿少赚一点，也想自己决定怎么做。' },
    { source: 2, quote: '涉及生活开支的时候，收入得先有保障。' },
  ],
}
const analyzed = { ...suggestion, basis: '两处原话分别说明了自由和生活开支的优先顺序。' }
const wrongSource = { ...suggestion, citations: [{ ...suggestion.citations[0], source: 2 }] }

function setup() {
  const db = createMockDb()
  return { db, app: createTestApp(diaryRoute, '/api/diary', db) }
}

describe('diary analysis', () => {
  beforeEach(() => vi.resetAllMocks())

  it('analyzes the entries jointly, shows matching quotations only, and does not save the preview', async () => {
    vi.mocked(analyzeDiaries).mockResolvedValue([analyzed, { ...analyzed, citations: wrongSource.citations }])
    const { app, db } = setup()
    const res = await req(app, 'POST', '/api/diary/analyze', { entries })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toMatchObject({ id: expect.any(String), suggestions: [suggestion] })
    expect(analyzeDiaries).toHaveBeenCalledExactlyOnceWith(entries)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('rejects invalid dates and blank originals without calling the model', async () => {
    const { app } = setup()
    const path = '/api/diary/analyze'
    expect((await req(app, 'POST', path, { entries: [{ ...entries[0], date: '2026-02-30' }] })).status).toBe(400)
    expect((await req(app, 'POST', path, { entries: [{ ...entries[0], content: '  ' }] })).status).toBe(400)
    expect(analyzeDiaries).not.toHaveBeenCalled()
  })

  it('accepts a large folder, unknown dates, and a body bigger than the former HTTP limit', async () => {
    const { app, db } = setup()
    const long = { ...entries[1], date: null, content: entries[1].content.padEnd(1_050_000, 'x') }
    const archive = [...Array(153).fill(entries[0]), long]
    const highSource = { ...suggestion, citations: [{ ...suggestion.citations[1], source: 154 }] }
    vi.mocked(analyzeDiaries).mockResolvedValue([{ ...analyzed, citations: highSource.citations }])
    expect(await req(app, 'POST', '/api/diary/analyze', { entries: archive })).toMatchObject({ status: 200, body: { suggestions: [highSource] } })
    expect(analyzeDiaries).toHaveBeenCalledExactlyOnceWith(archive)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('streams verified items and one final preview without saving', async () => {
    const { app, db } = setup()
    const item = analyzed
    vi.mocked(analyzeDiaries).mockImplementation(async (_, options) => {
      await options?.onSummary?.('公开摘要片段')
      await options?.onItem?.({ ...item, citations: wrongSource.citations })
      await options?.onItem?.(item)
      return [item]
    })
    const response = await app.request('/api/diary/analyze', {
      method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    })
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect((await response.text()).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { type: 'progress', phase: 'analyze' },
      { type: 'summary', delta: '公开摘要片段' },
      { type: 'item', item },
      { type: 'result', id: expect.any(String), suggestions: [item] },
    ])
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('explains API context overflow without leaking upstream details or retrying', async () => {
    const { app, db } = setup()
    vi.mocked(analyzeDiaries).mockRejectedValue(new APICallError({
      message: 'private content: maximum context length exceeded', url: 'https://example.invalid',
      requestBodyValues: {}, statusCode: 400, data: { error: { code: 'context_length_exceeded' } },
    }))
    const res = await req(app, 'POST', '/api/diary/analyze', { entries })
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('没有自动拆分')
    expect(res.body.error).not.toContain('private content')
    expect(analyzeDiaries).toHaveBeenCalledTimes(1)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('validates each quotation against the corresponding original when saving', async () => {
    const { app, db } = setup()
    const res = await req(app, 'POST', '/api/diary/save', { entries, id: randomUUID(), suggestions: [wrongSource] })
    expect(res.status).toBe(400)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('writes only selected facts and their original diaries and quotations in the same transaction', async () => {
    const { app, db } = setup()
    const id = randomUUID()
    const batchValues = vi.fn(() => ({ onConflictDoNothing: () => ({ returning: async () => [{ id }] }) }))
    const diaryValues = vi.fn<(rows: { id: string }[]) => void>()
    const factValues = vi.fn<(rows: { id: string }[]) => void>()
    const evidenceValues = vi.fn()
    const insert = vi.fn(table => ({ values: table === diarySavedBatches ? batchValues : table === diaryEntries ? diaryValues : table === structuredFacts ? factValues : evidenceValues }))
    vi.mocked(db.transaction).mockImplementation((cb: any) => cb({ insert }))
    const res = await req(app, 'POST', '/api/diary/save', { entries, id, suggestions: [suggestion] })
    expect(res).toMatchObject({ status: 201, body: { saved: 1 } })
    expect(insert.mock.calls).toEqual([[diarySavedBatches], [diaryEntries], [structuredFacts], [diaryFactEvidences]])
    expect(batchValues).toHaveBeenCalledWith({ id, userId: 'test-user-id' })
    expect(diaryValues).toHaveBeenCalledWith(entries.slice(0, 2).map(({ date, ...entry }) => ({ id: expect.any(String), userId: 'test-user-id', entryDate: date, ...entry })))
    expect(factValues).toHaveBeenCalledWith([{ id: expect.any(String), userId: 'test-user-id', category: suggestion.category, fact: suggestion.fact, visibility: 'private', source: 'diary' }])
    const [fact] = factValues.mock.calls[0][0]
    const diaries = diaryValues.mock.calls[0][0]
    expect(evidenceValues).toHaveBeenCalledWith(suggestion.citations.map(({ source, quote }, ordinal) => ({ factId: fact.id, diaryId: diaries[source - 1].id, ordinal, quote })))
    expect(analyzeDiaries).not.toHaveBeenCalled()
  })
})
