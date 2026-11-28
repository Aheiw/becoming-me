import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { InterviewDiary } from '../../lib/interviewHistory.js'
import { api, body, Field } from './shared.js'
import styles from './Personal.module.css'

type Draft = InterviewDiary & { key: number }
function filenameDate(name: string) {
  const parts = name.match(/(?<!\d)(\d{4})(?:[-_.年](\d{1,2})[-_.月](\d{1,2})|(\d{2})(\d{2}))(?!\d)/)
  if (!parts) return null
  const date = `${parts[1]}-${(parts[2] ?? parts[4]).padStart(2, '0')}-${(parts[3] ?? parts[5]).padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date ? date : null
}
export default function DiaryImport({ saved, cancel, busy }: { saved: (id: string, analyze: boolean) => void; cancel: () => void; busy: boolean }) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [paste, setPaste] = useState(''), [date, setDate] = useState(''), [problem, setProblem] = useState(''), [pending, setPending] = useState(false)
  const key = useRef(0), inFlight = useRef(false)
  async function files(e: ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''
    if (!all.length || inFlight.current) return
    inFlight.current = true; setPending(true); setProblem('')
    try {
      const ok: Draft[] = [], failed: string[] = []
      for (const file of all) {
        try {
          if (!/\.(txt|md)$/i.test(file.name)) throw new Error()
          const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
          if (!content.trim() || content.includes('\0')) throw new Error()
          ok.push({ key: key.current++, filename: file.name, date: filenameDate(file.name), content })
        } catch { failed.push(file.name) }
      }
      setDrafts(prev => [...prev, ...ok])
      if (failed.length) setProblem(`有 ${failed.length} 个文件未读取；请选非空的 UTF-8 文本：${failed.slice(0, 5).join('、')}`)
    } finally { inFlight.current = false; setPending(false) }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const analyze = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'analyze'
    if (inFlight.current || (analyze && busy) || (!drafts.length && !paste.trim())) return
    if (paste.includes('\0')) { setProblem('粘贴的正文带有无效字符，请清理后重试。'); return }
    inFlight.current = true; setPending(true); setProblem('')
    const entries = drafts.map(({ filename, date, content }) => ({ filename, date, content }))
    if (paste.trim()) entries.push({ filename: null, date: date || null, content: paste })
    try {
      const { id } = await api<{ id: string }>('/diary-sources', body({ origin: 'import', entries }))
      saved(id, analyze)
    } catch (err) { setProblem((err as Error).message) }
    finally { inFlight.current = false; setPending(false) }
  }
  return <form className={`${styles.card} ${styles.form}`} onSubmit={save}>
    <h2>导入日记原文</h2><p className={styles.muted}>可以多选 .txt、.md 文件，也能粘贴一篇。仅保存不调用 AI。</p>
    <Field label="选择文件"><input type="file" multiple accept=".txt,.md" onChange={files} disabled={pending} /></Field>
    <Field label="或选择整个文件夹"><input ref={node => { node?.setAttribute('webkitdirectory', '') }} type="file" multiple onChange={files} disabled={pending} /></Field>
    {!!drafts.length && <details className={styles.details}><summary>已选 {drafts.length} 篇 · 检查日期或移除</summary>
      {drafts.map(d => <div key={d.key} className={styles.actions}>
        <Field label={d.filename ?? '写作日期'}><input type="date" value={d.date ?? ''} disabled={pending} onChange={e => { const date = e.target.value || null; setDrafts(prev => prev.map(p => p.key === d.key ? { ...p, date } : p)) }} /></Field>
        <button type="button" disabled={pending} onClick={() => setDrafts(prev => prev.filter(p => p.key !== d.key))}>移除</button>
      </div>)}
    </details>}
    <details className={styles.details}><summary>粘贴一篇日记（可选）</summary>
      <Field label="写作日期（可选）"><input type="date" value={date} disabled={pending} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="粘贴原文"><textarea rows={5} value={paste} disabled={pending} onChange={e => setPaste(e.target.value)} /></Field>
    </details>
    <div className={styles.actions}>
      <button className={styles.primary} type="submit" disabled={pending || (!drafts.length && !paste.trim())}>仅保存到资料库</button>
      <button type="submit" value="analyze" disabled={pending || busy || (!drafts.length && !paste.trim())}>保存并立即分析</button>
      <button type="button" disabled={pending} onClick={cancel}>取消</button>
    </div>
    {problem && <p role="alert" className={styles.error}>{problem}</p>}
  </form>
}
