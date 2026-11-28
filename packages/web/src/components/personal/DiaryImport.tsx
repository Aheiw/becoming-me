import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { InterviewDiary } from '../../lib/interviewHistory.js'
import { detectBodyDate, filenameDate, splitDiaryCollection } from '../../lib/diarySplit.js'
import { api, body, Field } from './shared.js'
import styles from './Personal.module.css'

type Draft = InterviewDiary & { key: number; dateHint?: string }

export default function DiaryImport({ saved, cancel, busy }: { saved: (id: string, analyze: boolean) => void; cancel: () => void; busy: boolean }) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [paste, setPaste] = useState(''), [date, setDate] = useState(''), [problem, setProblem] = useState(''), [pending, setPending] = useState(false)
  const key = useRef(0), inFlight = useRef(false)

  function buildDraft(filename: string | null, content: string): Draft {
    const byName = filename ? filenameDate(filename) : null
    if (byName) return { key: key.current++, filename, date: byName, content, dateHint: '文件名' }
    const byBody = detectBodyDate(content)
    if (byBody) return { key: key.current++, filename, date: byBody, content, dateHint: '正文识别' }
    return { key: key.current++, filename, date: null, content }
  }

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
          ok.push(buildDraft(file.name, content))
        } catch { failed.push(file.name) }
      }
      setDrafts(prev => [...prev, ...ok])
      if (failed.length) setProblem(`有 ${failed.length} 个文件未读取；请选非空的 UTF-8 文本：${failed.slice(0, 5).join('、')}`)
    } finally { inFlight.current = false; setPending(false) }
  }

  function splitDraft(targetKey: number) {
    setDrafts(prev => prev.flatMap(item => {
      if (item.key !== targetKey) return [item]
      const parts = splitDiaryCollection(item.filename, item.content)
      if (parts.length < 2) return [item]
      return parts.map(p => ({ key: key.current++, filename: p.filename, date: p.date, content: p.content, dateHint: p.date ? '正文拆篇' : undefined }))
    }))
  }

  function splitPaste() {
    const parts = splitDiaryCollection(null, paste)
    if (parts.length < 2) return
    setDrafts(prev => [...prev, ...parts.map(p => ({ key: key.current++, filename: null, date: p.date, content: p.content, dateHint: p.date ? '正文拆篇' : undefined }))])
    setPaste(''); setDate('')
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const analyze = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'analyze'
    if (inFlight.current || (analyze && busy) || (!drafts.length && !paste.trim())) return
    if (paste.includes('\0')) { setProblem('粘贴的正文带有无效字符，请清理后重试。'); return }
    inFlight.current = true; setPending(true); setProblem('')
    const entries = drafts.map(({ filename, date, content }) => ({ filename, date, content }))
    if (paste.trim()) entries.push({ filename: null, date: (date || detectBodyDate(paste)) || null, content: paste })
    try {
      const { id } = await api<{ id: string }>('/diary-sources', body({ origin: 'import', entries }))
      saved(id, analyze)
    } catch (err) { setProblem((err as Error).message) }
    finally { inFlight.current = false; setPending(false) }
  }

  const pasteParts = paste.trim() ? splitDiaryCollection(null, paste) : []

  return <form className={`${styles.card} ${styles.form}`} onSubmit={save}>
    <h2>导入日记原文</h2><p className={styles.muted}>可以多选 .txt、.md 文件，也能粘贴。会自动从文件名或正文开头预识别日期；长合集可预览拆篇，不改动磁盘原文件。</p>
    <Field label="选择文件"><input type="file" multiple accept=".txt,.md" onChange={files} disabled={pending} /></Field>
    <Field label="或选择整个文件夹"><input ref={node => { node?.setAttribute('webkitdirectory', '') }} type="file" multiple onChange={files} disabled={pending} /></Field>
    {!!drafts.length && <details className={styles.details} open><summary>已准备 {drafts.length} 篇 · 检查日期、拆篇或移除</summary>
      {drafts.map(d => {
        const parts = splitDiaryCollection(d.filename, d.content)
        return <div key={d.key} className={styles.segment}>
          <div className={styles.actions}>
            <Field label={`${d.filename ?? '拆篇草稿'}${d.dateHint ? `（${d.dateHint}）` : ''}`}><input type="date" value={d.date ?? ''} disabled={pending} onChange={e => { const next = e.target.value || null; setDrafts(prev => prev.map(p => p.key === d.key ? { ...p, date: next, dateHint: next ? '手动调整' : undefined } : p)) }} /></Field>
            {parts.length >= 2 && <button type="button" disabled={pending} onClick={() => splitDraft(d.key)}>按正文拆为 {parts.length} 篇</button>}
            <button type="button" disabled={pending} onClick={() => setDrafts(prev => prev.filter(p => p.key !== d.key))}>移除</button>
          </div>
          <p className={styles.muted}>{d.content.slice(0, 90)}{d.content.length > 90 ? '…' : ''}</p>
        </div>
      })}
    </details>}
    <details className={styles.details}><summary>粘贴一篇或一段合集（可选）</summary>
      <Field label="写作日期（留空将尝试从正文首行识别）"><input type="date" value={date} disabled={pending} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="粘贴原文"><textarea rows={5} value={paste} disabled={pending} onChange={e => setPaste(e.target.value)} /></Field>
      {pasteParts.length >= 2 && <div className={styles.actions}><button type="button" disabled={pending} onClick={splitPaste}>检测到 {pasteParts.length} 个日期段落 · 拆篇预览</button></div>}
    </details>
    <div className={styles.actions}>
      <button className={styles.primary} type="submit" disabled={pending || (!drafts.length && !paste.trim())}>仅保存到资料库</button>
      <button type="submit" value="analyze" disabled={pending || busy || (!drafts.length && !paste.trim())}>保存并立即分析</button>
      <button type="button" disabled={pending} onClick={cancel}>取消</button>
    </div>
    {problem && <p role="alert" className={styles.error}>{problem}</p>}
  </form>
}
