import { afterEach, expect, it, vi } from 'vitest'
import { streamObject } from 'ai'
import { z } from 'zod'
import { analyzeDiaries } from './diary.js'
import { modelFailure } from './modelFailure.js'
import { getDiarySummaryModel } from './diarySummary.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('streams only public summary deltas and structured output in one Responses request', async () => {
  vi.stubEnv('BECOMING_ME_LOCAL', '1')
  vi.stubEnv('LLM_PROVIDER', 'openai')
  vi.stubEnv('LLM_MODEL', 'gpt-6.2-sol')
  vi.stubEnv('OPENAI_API_KEY', 'mock-key')
  vi.stubEnv('OPENAI_BASE_URL', 'https://example.invalid/v1')
  const payloads = [
    { type: 'response.reasoning_text.delta', delta: 'must not be shown' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: 'Public ' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, summary_index: 0, delta: 'summary.' },
    { type: 'response.output_text.delta', delta: '{"elements":[{"text":"suggestion"}]}' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 8 } } },
  ]
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(
    payloads.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } },
  ))
  vi.stubGlobal('fetch', fetcher)
  const receive = vi.fn()
  const model = getDiarySummaryModel(receive)!
  const { object, elementStream } = streamObject({ model, mode: 'json', output: 'array', schema: z.object({ text: z.string() }), prompt: 'Synthetic diary.' })
  const elements = []
  for await (const item of elementStream) elements.push(item)
  expect(elements).toEqual([{ text: 'suggestion' }])
  expect(await object).toEqual(elements)
  expect(receive.mock.calls).toEqual([['Public '], ['summary.']])
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe('https://example.invalid/v1/responses')
  expect(JSON.parse(String(init.body))).toMatchObject({ store: false, stream: true, reasoning: { summary: 'auto' } })
})

it('does not enable the Responses transport for other setups', () => {
  vi.stubEnv('BECOMING_ME_LOCAL', '1')
  vi.stubEnv('LLM_PROVIDER', 'anthropic')
  expect(getDiarySummaryModel(vi.fn())).toBeNull()
})

function fakeProvider() {
  vi.stubEnv('BECOMING_ME_LOCAL', '1')
  vi.stubEnv('LLM_PROVIDER', 'openai')
  vi.stubEnv('LLM_MODEL', 'test-only')
  vi.stubEnv('OPENAI_API_KEY', 'mock-key')
  vi.stubEnv('OPENAI_BASE_URL', 'https://example.invalid/v1')
}
function sse(events: object[]) {
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}
const diary = { date: '2026-01-02', filename: '测试.txt', content: '我重新参加了纸飞机比赛。' }
it('sends a strict schema with every field required, including nullable draft fields', async () => {
  fakeProvider()
  const suggestion = { category: 'life_events', fact: diary.content, citations: [{ source: 1, quote: diary.content }], basis: '虚构测试。', title: '参加比赛', eventDraft: null, contextDraft: null, profileDraft: null }
  type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[] }
  const server = vi.fn(async (_url: string, init: RequestInit) => {
    const { text } = JSON.parse(String(init.body))
    function check(schema: Schema) {
      if (schema.type === 'object') expect(schema.required?.slice().sort()).toEqual(Object.keys(schema.properties ?? {}).sort())
      for (const child of Object.values(schema.properties ?? {})) check(child)
      if (schema.items) check(schema.items)
      for (const child of schema.anyOf ?? []) check(child)
    }
    check(text.format.schema)
    return sse([{ type: 'response.output_text.delta', delta: JSON.stringify({ elements: [suggestion] }) },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 8 } } }])
  })
  vi.stubGlobal('fetch', server)
  await expect(analyzeDiaries([diary], { workspace: true, onSummary: vi.fn() })).resolves.toEqual([suggestion])
  expect(server).toHaveBeenCalledTimes(1)
})

it('maps a streamed schema error without exposing the provider message', async () => {
  fakeProvider()
  vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'error', error: { code: 'invalid_json_schema', type: 'invalid_request_error', param: null, message: 'private provider message' } }])))
  await analyzeDiaries([diary], { workspace: true, onSummary: vi.fn() }).then(
    () => { throw new Error('expected the streamed provider error to fail analysis') },
    error => {
      expect(modelFailure(error)).toMatchObject({ status: 502, message: expect.stringContaining('输出结构') })
      expect(modelFailure(error)?.message).not.toContain('private provider message')
    },
  )
})
