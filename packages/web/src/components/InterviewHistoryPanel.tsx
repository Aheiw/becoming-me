import { useEffect, useState } from 'react'
import { interviewHistoryRequest, type InterviewDiaryDetails, type InterviewHistory } from '../lib/interviewHistory.js'
import { diaryCategoryLabels } from './DiaryEvidence.js'
import styles from './Chat.module.css'

const when = (date: string) => new Date(date).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export default function InterviewHistoryPanel({ sessionId, busy, onOpen, onAddDiaries }: {
  sessionId: string | null
  busy: boolean
  onOpen: (id: string) => void
  onAddDiaries: () => void
}) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<InterviewHistory | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<(InterviewDiaryDetails & { id: string }) | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setError('')
    setHistory(null)
    interviewHistoryRequest<InterviewHistory>('', { signal: controller.signal }).then(setHistory).catch(err => {
      if (!controller.signal.aborted) setError((err as Error).message)
    })
    return () => controller.abort()
  }, [open, sessionId, busy])

  async function inspect(id: string) {
    if (working) return
    if (preview?.id === id) { setPreview(null); return }
    setWorking(true)
    setError('')
    try { setPreview({ id, ...(await interviewHistoryRequest<InterviewDiaryDetails>(`/diaries/${id}`)) }) }
    catch (err) { setError((err as Error).message) }
    finally { setWorking(false) }
  }

  async function remove(id: string) {
    if (working || busy || !window.confirm('移除这批日记及其分析？它们不再带入访谈，但已记录的访谈消息、百科条目和原文件不受影响。')) return
    setWorking(true)
    setError('')
    try {
      await interviewHistoryRequest(`/diaries/${id}`, { method: 'DELETE' })
      setHistory(data => data && { ...data, diaries: data.diaries.filter(batch => batch.id !== id) })
      setPreview(data => data?.id === id ? null : data)
    } catch (err) { setError((err as Error).message) }
    finally { setWorking(false) }
  }

  return <details className={styles.historyPanel} onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setPreview(null) }}>
    <summary>访谈历史与日记</summary>
    <p>历史问答、带入的日记原文和综合分析结果均保存在本机。发送访谈消息时，这些资料会发给已配置的模型 API；结束本轮不会清除历史。</p>
    <button type="button" disabled={busy} onClick={onAddDiaries}>去分析日记</button>
    {error && <p role="alert">{error}</p>}
    {!history && !error && open && <p role="status">正在读取历史…</p>}
    {history && <>
      <h3>历次访谈</h3>
      {!history.sessions.length && <p>还没有访谈记录。</p>}
      <ul>
        {history.sessions.map(session => <li key={session.id}>
          <button type="button" disabled={busy || session.id === sessionId} onClick={() => onOpen(session.id)}>
            {when(session.startedAt)} · {session.type === 'onboarding' ? '初次访谈' : '访谈'} · {session.status === 'active' && session.type === 'regular' ? '可继续' : '可查看'}{session.id === sessionId ? ' · 当前' : ''}
          </button>
        </li>)}
      </ul>
      <h3>带入访谈的日记</h3>
      {!history.diaries.length && <p>还没有带入日记。综合分析完成后，请点「带着分析继续访谈」。</p>}
      <ul>
        {history.diaries.map(batch => <li key={batch.id}>
          <span>{batch.filename ? `${batch.filename} · ` : ''}{batch.count} 篇 · {when(batch.createdAt)}{batch.hasAnalysis ? ' · 已综合分析' : ' · 仅原文（旧记录）'}</span>{' '}
          <button type="button" disabled={working} onClick={() => inspect(batch.id)}>{preview?.id === batch.id ? '收起资料' : '查看资料'}</button>{' '}
          <button type="button" disabled={working || busy} onClick={() => remove(batch.id)}>移除</button>
          {preview?.id === batch.id && <div className={styles.diaryOriginals}>
            {preview.analysis !== null && <details>
              <summary>查看综合分析</summary>
              {preview.analysis.length ? <ol>{preview.analysis.map((item, i) => <li key={i}>
                <strong>{diaryCategoryLabels[item.category] ?? item.category} · AI 归纳：</strong>{item.fact}
                <p>依据：{item.basis}</p>
                {item.citations.map(({ source, quote }) => <blockquote key={JSON.stringify([source, quote])}>第 {source} 篇原话：{quote}</blockquote>)}
              </li>)}</ol> : <p>已综合分析，没有生成可引用的百科建议。</p>}
            </details>}
            {preview.entries.map((entry, i) => <details key={i}>
              <summary>第 {i + 1} 篇 · {entry.date ?? '日期未知'}{entry.filename ? ` · ${entry.filename}` : ''}</summary>
              <pre>{entry.content}</pre>
            </details>)}
          </div>}
        </li>)}
      </ul>
    </>}
  </details>
}
