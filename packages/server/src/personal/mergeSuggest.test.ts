import { afterEach, expect, it, vi } from 'vitest'
import { suggestDuplicateArticles } from './model.js'
import { mergeDiaryFindings } from '../llm/diary.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function fakeLocal() {
  vi.stubEnv('BECOMING_ME_LOCAL', '1')
  vi.stubEnv('LLM_PROVIDER', 'openai')
  vi.stubEnv('LLM_MODEL', 'test-only')
  vi.stubEnv('OPENAI_API_KEY', 'mock-key')
  vi.stubEnv('OPENAI_BASE_URL', 'https://example.invalid/v1')
}

it('suggestDuplicateArticles filters invalid ids and falls back to plain text JSON', async () => {
  fakeLocal()
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++
    if (calls <= 2) {
      return new Response(JSON.stringify({ error: { message: 'tools/json unsupported' } }), { status: 400 })
    }
    const payload = {
      groups: [
        {
          ids: ['a1', 'a2', 'hallucinated-id'],
          suggestedTitle: '对合作边界的看法',
          reason: '两篇都在谈签约前要保留退出条款。',
          caution: '保留各自具体的项目背景。',
        },
        {
          ids: ['a3'],
          suggestedTitle: '单条无效',
          reason: '只有一条不能算组',
          caution: '',
        },
      ],
    }
    return new Response(JSON.stringify({
      id: 'merge-sug', created: 1760000000, model: 'test-only',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
    }), { headers: { 'Content-Type': 'application/json' } })
  }))

  const groups = await suggestDuplicateArticles([
    { id: 'a1', title: '看重退出条款', fact: '接长期合作前先看能不能退出。' },
    { id: 'a2', title: '不签死长期绑定', fact: '更在意保留季度重谈和退出的空间。' },
    { id: 'a3', title: '作息偏好', fact: '早上效率高。' },
  ], new AbortController().signal)

  expect(groups).toEqual([{
    ids: ['a1', 'a2'],
    suggestedTitle: '对合作边界的看法',
    reason: '两篇都在谈签约前要保留退出条款。',
    caution: '保留各自具体的项目背景。',
  }])
})

it('mergeDiaryFindings falls back to plain text JSON when tool and json modes fail', async () => {
  fakeLocal()
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++
    if (calls <= 2) {
      return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 })
    }
    const merged = [{
      category: 'patterns',
      fact: '搬家通常与生活或学习距离相关。',
      citations: [{ source: 1, quote: '第一次搬家是为了离学校近。' }],
      basis: '两段材料指向同一个习惯。',
    }]
    return new Response(JSON.stringify({
      id: 'merge-text', created: 1760000000, model: 'test-only',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(merged) } }],
    }), { headers: { 'Content-Type': 'application/json' } })
  }))

  const result = await mergeDiaryFindings([{
    category: 'patterns',
    fact: '搬家为了离学校近。',
    citations: [{ source: 1, quote: '第一次搬家是为了离学校近。' }],
    basis: '原文记录。',
  }], new AbortController().signal)

  expect(result).toHaveLength(1)
  expect(result[0].fact).toBe('搬家通常与生活或学习距离相关。')
})
