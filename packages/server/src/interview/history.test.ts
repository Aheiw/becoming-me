import { describe, expect, it } from 'vitest'
import { interviewHistoryMessage } from './history.js'

describe('local interview history context', () => {
  it('does not inject a placeholder if there are no earlier sources', () => {
    expect(interviewHistoryMessage({ transcript: [], diaryBatches: [] })).toBeNull()
  })

  it('retains the full diaries and prior dialogue, distinguishing the speakers', () => {
    const content = '先前的偏好。\r\n' + '中间没有删节。'.repeat(3000) + '\n这句话保留原样。 '
    const entries = [{ date: null, filename: '自述.txt', content }, { date: '2026-07-27', filename: null, content: '我后来修正了这个看法。' }]
    const transcript = [
      { sessionId: 's1', role: 'assistant', content: '你怎么做决定？', createdAt: new Date('2026-07-20') },
      { sessionId: 's1', role: 'user', content: '要先看情况。', createdAt: new Date('2026-07-21') },
    ]
    const message = interviewHistoryMessage({ transcript, diaryBatches: [{ id: 'b1', entries, analysis: null }] })!
    const payload = JSON.parse(message.content.split('\n')[1])
    expect(payload.previousInterviewMessages).toEqual(transcript.map(log => ({
      sessionId: log.sessionId, speaker: log.role, content: log.content, at: log.createdAt.toISOString(),
    })))
    expect(payload.diaryEntries).toEqual(entries.map((entry, i) => ({ number: i + 1, ...entry })))
    expect(payload.diaryAnalyses).toEqual([])
  })

  it('sends the analysis separately and maps citations to their original entries across batches', () => {
    const entry = { date: null, filename: null, content: '偏好原文' }
    const suggestion = { category: 'preferences' as const, fact: 'AI 归纳', basis: '依据', citations: [{ source: 2, quote: entry.content }] }
    const message = interviewHistoryMessage({ transcript: [], diaryBatches: [
      { id: 'old', entries: [entry], analysis: null },
      { id: 'new', entries: [{ ...entry, content: '另一篇' }, entry], analysis: [suggestion] },
    ] })!
    const payload = JSON.parse(message.content.split('\n')[1])
    expect(payload.diaryAnalyses).toEqual([{ firstDiary: 2, lastDiary: 3, suggestions: [
      { ...suggestion, citations: [{ source: 3, quote: entry.content }] },
    ] }])
    expect(payload.diaryEntries[2].content).toBe(entry.content)
    expect(suggestion.citations[0].source).toBe(2)
  })
})
