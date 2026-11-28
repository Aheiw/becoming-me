import type { DiaryAnalysisItem, InterviewDiary } from './interviewHistory.js'

export type Result = { id: string; suggestions: DiaryAnalysisItem[]; profileChanged: number }
export type Progress = { type: 'progress'; phase: 'analyze'; batchId?: string } | { type: 'progress'; phase: 'read' | 'merge'; completed: number; total: number }
type AnalysisEvent = Progress | { type: 'summary'; delta: string } | ({ type: 'result' } & Result) | { type: 'error'; error: string }

export async function readDiaryAnalysis(input: { entries: InterviewDiary[] } | { batchId: string }, signal: AbortSignal, events: { progress?: (progress: Progress) => void; summary?: (delta: string) => void } = {}): Promise<Result> {
  const response = await fetch('/api/diary/analyze?workspace=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(input), signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? '请求未完成，请重试。')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    throw new Error('分析服务未返回进度，请刷新页面后重试。')
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error('分析连接已中断，请先检查收件箱是否已保存结果。')
      pending += value
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        const event = JSON.parse(pending.slice(0, end)) as AnalysisEvent
        pending = pending.slice(end + 1)
        if (event.type === 'progress') events.progress?.(event)
        else if (event.type === 'summary') events.summary?.(event.delta)
        else if (event.type === 'error') throw new Error(event.error)
        else if (event.type === 'result') return { id: event.id, suggestions: event.suggestions, profileChanged: event.profileChanged ?? 0 }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
