import { useEffect, useRef, useState } from 'react'
import { readDiaryAnalysis, type Progress } from '../../lib/diaryAnalysis.js'
import { interviewHistoryRequest, type InterviewHistory } from '../../lib/interviewHistory.js'
import styles from './Personal.module.css'

type Status = { text: string; suggestions?: number; warning?: boolean }

export function useJournalAnalysis(changed: () => void) {
  const current = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>()
  const [summary, setSummary] = useState('')
  useEffect(() => () => current.current?.abort(), [])
  async function start(batchId?: string) {
    if (current.current) return
    const controller = new AbortController()
    current.current = controller
    setBusy(true); setStatus({ text: batchId ? '正在准备分析…' : '正在查找待分析的日记…' })
    let done = 0, suggestions = 0, profileChanged = 0, failures = 0, firstError = ''
    const { signal } = controller
    const message = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成分析。'
    try {
      const ids = batchId ? [batchId] : (await interviewHistoryRequest<InterviewHistory>('', { signal })).diaries
        .filter(batch => !batch.hasAnalysis).reverse().map(batch => batch.id)
      if (!ids.length) { setStatus({ text: '没有待分析的日记。' }); return }
      for (const [i, id] of ids.entries()) {
        signal.throwIfAborted()
        const label = batchId ? '正在分析' : `正在分析第 ${i + 1} / ${ids.length} 批`
        setStatus({ text: `${label}…` }); setSummary('')
        try {
          const progress = (p: Progress) => {
            if (p.phase !== 'analyze') setStatus({ text: `${label} · ${p.phase === 'read' ? '阅读' : '归并'} ${p.completed} / ${p.total}` })
          }
          const result = await readDiaryAnalysis({ batchId: id }, signal, { progress, summary: delta => setSummary(prev => (prev + delta).slice(-4000)) })
          done++; suggestions += result.suggestions.length; profileChanged += result.profileChanged
        } catch (err) {
          if (signal.aborted) throw err
          failures++; firstError ||= message(err)
        }
      }
      setStatus({ text: `已完成 ${done} 批，生成 ${suggestions} 条待核对建议。${profileChanged ? `「关于我」已更新 ${profileChanged} 条。` : ''}${failures ? ` ${failures} 批未完成，可再次运行。${firstError}` : ''}`, suggestions, warning: failures > 0 })
    } catch (err) {
      setStatus({ text: signal.aborted ? `已停止。完成的批次会保留；剩余日记可以稍后继续分析。${done ? ` 已完成 ${done} 批。` : ''}` : message(err), suggestions, warning: !signal.aborted })
    } finally {
      current.current = null; setBusy(false); changed()
    }
  }
  return { busy, status, summary, start, stop: () => current.current?.abort() }
}
export type JournalAnalysis = ReturnType<typeof useJournalAnalysis>

export function JournalAnalysisNotice({ analysis, openInbox }: { analysis: JournalAnalysis; openInbox: () => void }) {
  if (!analysis.status) return null
  return <div className={`${styles.banner} ${analysis.status.warning ? styles.error : ''}`}>
    <p role={analysis.status.warning ? 'alert' : 'status'}>{analysis.status.text}</p>
    {analysis.summary && <details><summary>模型提供的推理摘要</summary><p className={styles.preserve}>{analysis.summary}</p></details>}
    {analysis.busy ? <button type="button" onClick={analysis.stop}>停止分析</button>
      : Boolean(analysis.status.suggestions) && <button type="button" onClick={openInbox}>查看收件箱</button>}
  </div>
}
