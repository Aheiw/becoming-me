import { useState } from 'react'
import styles from './DiaryAnalysis.module.css'

export const diaryCategoryLabels: Record<string, string> = {
  character: '自我看法与性格', values: '价值观', preferences: '偏好', patterns: '决策与行为习惯',
  childhood: '童年', education: '教育', career: '职业', goals: '目标', skills: '技能',
  life_events: '人生经历', relationships: '关系', opinions: '观点', fears: '担忧与回避',
}

export type DiaryCitation = { id: string; date: string | null; filename: string | null; quote: string }

export function DiaryEvidence({ citations, fact }: { citations: DiaryCitation[]; fact: string }) {
  return (
    <div className={styles.evidence}>
      <p><strong>AI 归纳：</strong>{fact}</p>
      {citations.map(citation => <EvidenceQuote key={JSON.stringify([citation.id, citation.quote])} {...citation} />)}
    </div>
  )
}

function EvidenceQuote({ id, date, filename, quote }: DiaryCitation) {
  const [original, setOriginal] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  async function toggleOriginal() {
    if (open) { setOpen(false); return }
    if (original !== null) { setOpen(true); return }
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(`/api/diary/${encodeURIComponent(id)}`)
      if (!res.ok) throw new Error()
      const data = await res.json() as { content: string }
      setOriginal(data.content)
      setOpen(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.evidenceQuote}>
      <p className={styles.sourceLabel}>日记原话 · {date ? <time dateTime={date}>{date}</time> : '日期未知'}{filename && ` · ${filename}`}</p>
      <blockquote className={styles.quote}>{quote}</blockquote>
      <button className={styles.link} type="button" disabled={loading} aria-expanded={open} onClick={toggleOriginal}>
        {loading ? '正在读取…' : open ? '收起完整日记' : '查看完整日记'}
      </button>
      {error && <p role="alert" className={styles.error}>暂时无法读取完整日记，请重试。</p>}
      {open && <pre className={styles.original}>{original}</pre>}
    </div>
  )
}
