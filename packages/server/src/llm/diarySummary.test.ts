import { afterEach, expect, it, vi } from 'vitest'
import { streamObject } from 'ai'
import { z } from 'zod'
import { getDiarySummaryModel } from './diarySummary.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('streams only public summary deltas and structured output in one Responses request', async () => {
  vi.stubEnv('PCE_LOCAL', '1')
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
  vi.stubEnv('PCE_LOCAL', '1')
  vi.stubEnv('LLM_PROVIDER', 'anthropic')
  expect(getDiarySummaryModel(vi.fn())).toBeNull()
})
