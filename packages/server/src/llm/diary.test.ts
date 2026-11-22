import { beforeEach, expect, it, vi } from 'vitest'
import { streamObject } from 'ai'
import { analyzeDiaries } from './diary.js'
import { MAX_SUGGESTIONS, type DiaryAnalysisItem } from './diarySchemas.js'

vi.mock('ai', () => ({ streamObject: vi.fn() }))
vi.mock('./provider.js', () => ({ getLLM: vi.fn() }))

const newer = { date: '2026-11-22', filename: null, content: 'I prefer A when alone.' }
const earlier = { date: '2026-10-15', filename: null, content: 'For a group, I prefer B.' }
const a = { source: 1, quote: newer.content }
const b = { source: 2, quote: earlier.content }
const item: DiaryAnalysisItem = {
  category: 'preferences', fact: 'The preference depends on who is involved.',
  basis: 'The choice changes between the solo and group settings.', citations: [a, b],
}
const stream = vi.mocked(streamObject)
const response = (object: Promise<DiaryAnalysisItem[]>, elementStream: AsyncIterable<DiaryAnalysisItem>) =>
  ({ object, elementStream }) as unknown as ReturnType<typeof streamObject>
const emit = async function* (items: DiaryAnalysisItem[]) { yield* items }
const mockItems = (items: DiaryAnalysisItem[]) => stream.mockReturnValueOnce(response(Promise.resolve(items), emit(items)))

beforeEach(() => { stream.mockReset() })

it('sends all 154 originals, even a long file, in one call in date order with stable source IDs', async () => {
  const long = { date: null, filename: 'long.txt', content: `${'a'.repeat(58_738)}😀TAIL` }
  const entries = [newer, earlier, ...Array.from({ length: 151 }, (_, i) => ({ ...earlier, content: `Diary ${i}` })), long]
  const acrossArchive = { ...item, citations: [a, { source: 154, quote: '😀TAIL' }] }
  mockItems([acrossArchive])
  expect(await analyzeDiaries(entries)).toEqual([acrossArchive])
  expect(stream).toHaveBeenCalledTimes(1)
  const [, ...others] = entries
  const allNumbered = [ ...others.slice(0, -1).map(({ date, content }, i) => ({ date, content, source: i + 2 })),
    { date: newer.date, content: newer.content, source: 1 }, { date: null, content: long.content, source: 154 } ]
  expect(JSON.parse(stream.mock.calls[0][0].prompt!)).toEqual(allNumbered)
})

it('publishes only items with matching evidence before the final response is ready', async () => {
  const wrong = { ...item, citations: [{ ...a, source: 2 }] }
  const duplicate = { ...item, citations: [a, a, b] }
  let finish!: (items: DiaryAnalysisItem[]) => void
  const final = new Promise<DiaryAnalysisItem[]>(resolve => { finish = resolve })
  const onItem = vi.fn(() => finish([wrong, duplicate]))
  stream.mockReturnValueOnce(response(final, emit([wrong, duplicate])))
  expect(await analyzeDiaries([newer, earlier], { onItem })).toEqual([item])
  expect(onItem).toHaveBeenCalledExactlyOnceWith(item)
})

it('caps suggestions rather than input and preserves cancellation', async () => {
  const items = Array.from({ length: MAX_SUGGESTIONS + 2 }, (_, i) => ({ ...item, fact: String(i) }))
  mockItems(items)
  const onItem = vi.fn()
  expect(await analyzeDiaries([newer, earlier], { onItem })).toEqual(items.slice(0, MAX_SUGGESTIONS))
  expect(onItem).toHaveBeenCalledTimes(MAX_SUGGESTIONS)
  const controller = new AbortController()
  mockItems(items)
  await expect(analyzeDiaries([newer, earlier], { signal: controller.signal, onItem: () => controller.abort() }))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(stream.mock.calls[1][0].abortSignal?.aborted).toBe(true)
})

it('never treats a partial stream as the final result when the provider errors', async () => {
  const failure = new Error('stream interrupted')
  stream.mockReturnValueOnce(response(Promise.reject(failure), emit([item])))
  await expect(analyzeDiaries([newer, earlier])).rejects.toBe(failure)
})
