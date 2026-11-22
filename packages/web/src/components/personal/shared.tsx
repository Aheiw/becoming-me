import { useState, type ReactNode } from 'react'
import type { Article, Chapter, ComparisonFocus, Dream, EventImportance, Evidence, LifeEvent, Proposal, TurningPoint } from '../../../../server/src/personal/types.js'
import { diaryCategoryLabels } from '../DiaryEvidence.js'
import styles from './Personal.module.css'

export type { Article, Chapter, ComparisonFocus, Dream, EventImportance, Evidence, LifeEvent, Proposal, TurningPoint }
export type ArticleRow = Article & { id: string; deleted: boolean; updatedAt: string }
export type DreamRow = Pick<Dream, 'id' | 'title' | 'date' | 'updatedAt'>
export type Data = {
  events: LifeEvent[]; chapters: Chapter[]; articles: ArticleRow[]; proposals: Proposal[]; dreams: DreamRow[]; turningPoints: Record<string, TurningPoint[]>;
  focusId?: string; diaryFocusId?: string; dreamFocusId?: string; comparisonFocus?: ComparisonFocus
}
export type OpenComparison = (focus: ComparisonFocus) => void
export type Tab = 'overview' | 'book' | 'chat' | 'inbox' | 'events' | 'articles' | 'dreams'
export type Work = <T>(task: () => Promise<T>, message?: string) => Promise<T | undefined>
export const categoryName = (key: string) => diaryCategoryLabels[key] ?? key
export const categories = Object.keys(diaryCategoryLabels)
export const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export const stamp = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })
export const eventTime = (e: LifeEvent) => e.dateNote || e.date || '时间未定'
export const body = (data: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
export async function api<T>(path = '', init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/personal${path}`, init)
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(typeof error.error === 'string' ? error.error : '本地工作台暂时无法访问，请稍后重试。')
  }
  return res.json()
}
export function Page({ kicker, title, hint, actions, children }: { kicker: string; title: string; hint: string; actions?: ReactNode; children: ReactNode }) {
  return <section className={styles.page}>
    <header className={styles.pageHead}><div><p className={styles.kicker}>{kicker}</p><h1>{title}</h1><p className={styles.muted}>{hint}</p></div>{actions && <div className={styles.actions}>{actions}</div>}</header>
    {children}
  </section>
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className={styles.field}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function Empty({ children }: { children: ReactNode }) { return <div className={styles.empty}>{children}</div> }
export function EvidenceList({ evidence, title = '相关原话' }: { evidence: Evidence[]; title?: string }) {
  const [content, setContent] = useState<{ key: string; text: string; error?: boolean } | null>(null)
  if (!evidence.length) return null
  return <details className={styles.details}><summary>{title} · {evidence.length}</summary>{evidence.map((e, index) => {
    const key = `${e.kind}:${e.id}:${e.index ?? ''}:${index}`
    const show = content?.key === key
    return <div key={key} className={styles.source}><small>{e.kind === 'chat' ? '对话' : '日记'} · {e.date ?? '日期未知'} {e.label && `· ${e.label}`}</small>
      <blockquote>{e.quote}</blockquote>
      <button type="button" className={styles.link} onClick={async () => {
        if (show) { setContent(null); return }
        setContent({ key, text: '正在读取原文…' })
        try {
          const row = await api<{ content: string }>(`/evidence/${e.kind}/${encodeURIComponent(e.id)}${e.index === undefined ? '' : `?index=${e.index}`}`)
          setContent(prev => prev?.key === key ? { key, text: row.content } : prev)
        } catch (err) { setContent(prev => prev?.key === key ? { key, text: (err as Error).message, error: true } : prev) }
      }}>{show ? '收起原文' : '查看原文'}</button>
      {show && <pre role={content.error ? 'alert' : undefined} className={styles.original}>{content.text}</pre>}
    </div>
  })}</details>
}
export function EventLinks({ ids, events, open }: { ids: string[]; events: LifeEvent[]; open: (id: string) => void }) {
  const links = ids.map(id => events.find(e => e.id === id)).filter((e): e is LifeEvent => Boolean(e))
  if (!links.length) return null
  return <div className={styles.actions}>{links.map(e => <button type="button" key={e.id} onClick={() => open(e.id)}>{eventTime(e)} · {e.title}</button>)}</div>
}
