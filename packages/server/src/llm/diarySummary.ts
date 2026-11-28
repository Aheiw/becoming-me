import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel } from 'ai'

export function getDiarySummaryModel(onSummary: (delta: string) => void | Promise<void>) {
  if (process.env.BECOMING_ME_LOCAL !== '1' || process.env.LLM_PROVIDER !== 'openai' || !process.env.OPENAI_BASE_URL || !process.env.LLM_MODEL) return null

  const model = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.OPENAI_BASE_URL,
    fetch: (input, init) => {
      // This SDK version gates reasoning options by known model name prefixes.
      // Request the public summary explicitly for the locally configured model alias.
      const body = JSON.parse(String(init?.body))
      const headers = new Headers(init?.headers)
      if (headers.get('authorization') === 'Bearer') headers.delete('authorization')
      return fetch(input, {
        ...init, headers, redirect: 'error',
        body: JSON.stringify({ ...body, store: false, reasoning: { summary: 'auto' } }),
      })
    },
  }).responses(process.env.LLM_MODEL ?? 'gpt-4o-mini')

  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream()
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            async transform(part, controller) {
              // The Responses adapter maps only response.reasoning_summary_text.delta
              // to this part. Never forward reasoning fields from Chat Completions.
              if (part.type === 'reasoning') {
                if (part.textDelta) await onSummary(part.textDelta)
              } else {
                controller.enqueue(part)
              }
            },
          })),
        }
      },
    },
  })
}
