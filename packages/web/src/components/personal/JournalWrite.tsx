import { useRef, useState, type FormEvent } from 'react'
import { api, body, day, Field, Page } from './shared.js'
import { JournalAnalysisNotice, type JournalAnalysis } from './JournalAnalysis.js'
import styles from './Personal.module.css'

export default function JournalWrite({ analysis, onSaved, openLibrary, openInbox, discussJournal }: {
  analysis: JournalAnalysis; onSaved: () => void; openLibrary: () => void; openInbox: () => void; discussJournal?: (prompt: string) => void
}) {
  const [date, setDate] = useState(day), [title, setTitle] = useState(''), [content, setContent] = useState('')
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [lastSaved, setLastSaved] = useState<{ date: string; title: string; content: string } | null>(null)
  const inFlight = useRef(false)
  const characters = Array.from(content.replace(/\s/gu, '')).length
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const analyze = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'analyze'
    if (inFlight.current || !date || !characters || (analyze && analysis.busy)) return
    inFlight.current = true; setSaving(true); setError(''); setLastSaved(null)
    const snapshot = { date, title: title.trim(), content }
    try {
      const { id } = await api<{ id: string }>('/diary-sources', body({ origin: 'journal', entries: [{ date, filename: snapshot.title || null, content }] }))
      setTitle(''); setContent(''); setLastSaved(snapshot); onSaved()
      if (analyze) void analysis.start(id)
    } catch (err) { setError((err as Error).message) }
    finally { inFlight.current = false; setSaving(false) }
  }
  const chatPrompt = lastSaved
    ? `我刚写了一篇日记（${lastSaved.date}${lastSaved.title ? ` · ${lastSaved.title}` : ''}）：\n\n${lastSaved.content.slice(0, 600)}${lastSaved.content.length > 600 ? '…' : ''}\n\n想跟你聊聊这篇里值得细看的地方：`
    : ''
  return <Page kicker="个人档案 / 日记" title="写日记" hint="先写下你想记住的事。可以只保存，也可以保存后马上让 AI 分析，或顺便带进长期对话聊聊。" actions={<button type="button" onClick={openLibrary}>打开日记资料库</button>}>
    <form className={`${styles.card} ${styles.form}`} onSubmit={save}>
      <fieldset disabled={saving}>
        <div className={styles.grid}>
          <Field label="写作日期"><input required type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="标题（可选）"><input value={title} maxLength={260} onChange={e => setTitle(e.target.value)} /></Field>
        </div>
        <Field label="正文"><textarea required rows={13} value={content} placeholder="今天，有什么是以后还想记得的？" onChange={e => { setContent(e.target.value); setLastSaved(null) }} /></Field>
        <p className={styles.muted}>{characters.toLocaleString('zh-CN')} 字 · 不含空白</p>
        <div className={styles.actions}>
          <button className={styles.primary} type="submit" disabled={!characters || !date}>{saving ? '正在保存…' : '仅保存'}</button>
          <button type="submit" value="analyze" disabled={!characters || !date || analysis.busy}>保存并立即分析</button>
        </div>
        <small>仅保存不会调用 AI。选择分析后，模型会读取相关内容，提议的事件、百科、人物、环境和关系先进入收件箱。</small>
      </fieldset>
      {lastSaved && <div className={styles.actions}>
        <span role="status">日记原文已保存在本地资料库。</span>
        {discussJournal && <button type="button" onClick={() => discussJournal(chatPrompt)}>带着这篇去长期对话聊聊</button>}
      </div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </form>
    <JournalAnalysisNotice analysis={analysis} openInbox={openInbox} />
  </Page>
}
