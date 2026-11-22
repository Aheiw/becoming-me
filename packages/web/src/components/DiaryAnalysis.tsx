import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { type DiaryAnalysisItem, type InterviewDiary } from '../lib/interviewHistory.js'
import { diaryCategoryLabels } from './DiaryEvidence.js'
import { api, body, day } from './personal/shared.js'
import styles from './DiaryAnalysis.module.css'

type Entry = InterviewDiary
type Draft = Entry & { key: number }
type Suggestion = DiaryAnalysisItem
type Result = { id: string; suggestions: Suggestion[] }
type Preview = Result & { entries: Entry[] }
type AnalysisEvent = { type: 'progress'; phase: 'analyze' } | { type: 'summary'; delta: string } | { type: 'item'; item: Suggestion } | ({ type: 'result' } & Result) | { type: 'error'; error: string }

function filenameDate(name: string) {
  const parts = name.match(/(?<!\d)(\d{4})(?:[-_.年](\d{1,2})[-_.月](\d{1,2})|(\d{2})(\d{2}))(?!\d)/)
  if (!parts) return null
  const date = `${parts[1]}-${(parts[2] ?? parts[4]).padStart(2, '0')}-${(parts[3] ?? parts[5]).padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date ? date : null
}

async function readAnalysis(entries: Entry[], signal: AbortSignal, events: { started: () => void; summary: (delta: string) => void; item: (item: Suggestion) => void }): Promise<Result> {
  const response = await fetch('/api/diary/analyze?workspace=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ entries }), signal,
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
        if (event.type === 'progress') events.started()
        else if (event.type === 'summary') events.summary(event.delta)
        else if (event.type === 'item') events.item(event.item)
        else if (event.type === 'error') throw new Error(event.error)
        else if (event.type === 'result') return { id: event.id, suggestions: event.suggestions }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export default function DiaryAnalysis({ hidden, onViewInbox, onViewInterview, onAnalyzed }: { hidden: boolean; onViewInbox: () => void; onViewInterview: () => void; onAnalyzed: () => void }) {
  const nextKey = useRef(0)
  const analysis = useRef<AbortController | null>(null)
  useEffect(() => () => analysis.current?.abort(), [])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [pasting, setPasting] = useState(false)
  const [date, setDate] = useState(day)
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'file' | 'analyze' | 'attach' | 'save' | null>(null)
  const [error, setError] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [saveNote, setSaveNote] = useState('')
  const [started, setStarted] = useState(false)
  const [summary, setSummary] = useState('')
  const [live, setLive] = useState<Suggestion[]>([])
  const total = drafts.reduce((sum, entry) => sum + entry.content.length, 0)
  const undated = drafts.filter(entry => !entry.date).length

  function clearPreview() {
    setPreview(null)
    setSaveNote('')
    setSummary('')
    setError('')
  }

  async function saveSources() {
    if (busy || !drafts.length) return
    setBusy('save'); setError(''); setSaveNote('')
    try {
      const { count } = await api<{ count: number }>('/diary-sources', body({ entries: drafts.map(({ date, filename, content }) => ({ date, filename, content })) }))
      setSaveNote('已在本地保存 ' + count + ' 篇。现在可以在长期对话中查原文。'); onAnalyzed()
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(null) }
  }
  async function loadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!files.length || busy) return
    setBusy('file')
    setError('')
    setFileNote('')
    try {
      const additions: Draft[] = []
      const failures: string[] = []
      let empty = 0
      let other = 0
      for (const file of files) {
        if (!/\.(txt|md)$/i.test(file.name)) { other++; continue }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
          if (!text.trim()) { empty++; continue }
          if (text.includes('\0')) throw new Error()
          additions.push({ key: nextKey.current++, date: filenameDate(file.name), filename: file.name, content: text })
        } catch {
          failures.push(file.name)
        }
      }
      if (additions.length) {
        setDrafts(items => [...items, ...additions])
        clearPreview()
      }
      const notes = [`已添加 ${additions.length} 篇`, empty ? `跳过 ${empty} 个空文件` : null,
        other ? `跳过 ${other} 个非日记格式文件` : null]
      setFileNote(notes.filter(Boolean).join('；') + '。')
      if (failures.length) setError(`无法读取 ${failures.length} 个文件（请确认是 UTF-8 文本）：${failures.slice(0, 5).join('、')}${failures.length > 5 ? '…' : ''}`)
    } finally {
      setBusy(null)
    }
  }

  function addPasted() {
    if (!content.trim() || content.includes('\0')) return
    const key = nextKey.current++
    setDrafts(items => [...items, { key, date: date || null, filename: null, content }])
    setPasting(false)
    setContent('')
    setDate(day())
    clearPreview()
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || preview || !drafts.length || (pasting && content.trim())) return
    const entries = drafts.map(({ date, filename, content }) => ({ date, filename, content }))
    const controller = new AbortController()
    analysis.current = controller
    clearPreview()
    setStarted(false)
    setLive([])
    setBusy('analyze')
    try {
      const result = await readAnalysis(entries, controller.signal, {
        started: () => setStarted(true),
        summary: delta => setSummary(text => text + delta),
        item: item => setLive(items => [...items, item]),
      })
      setPreview({ ...result, entries })
      onAnalyzed()
    } catch (err) {
      setSummary('')
      setError(controller.signal.aborted ? '已停止读取分析；如果刚完成，可以在收件箱或日记原件查看。' : err instanceof TypeError ? '无法连接 PCE 分析服务，请确认它正在运行后重试。' : (err as Error).message)
    } finally {
      setLive([])
      analysis.current = null
      setBusy(null)
    }
  }

  async function continueChat() {
    if (!preview || busy) return
    setError(''); setBusy('attach')
    try { await api('/focus', body({ diaryId: preview.id })); onViewInterview() }
    catch (err) { setError((err as Error).message) }
    finally { setBusy(null) }
  }

  const visible = preview ?? (busy === 'analyze' && live.length ? { entries: drafts, suggestions: live } : null)
  const groups = new Map<string, { item: Suggestion; index: number }[]>()
  visible?.suggestions.forEach((item, index) => {
    const group = groups.get(item.category) ?? []
    group.push({ item, index })
    groups.set(item.category, group)
  })

  return (
    <section hidden={hidden} className={styles.panel}>
      <h1>分析日记</h1>
      <p className={styles.note}>对照整批日记，按主题整理百科建议，并保留支持这些建议的原话。</p>
      <form onSubmit={analyze} className={styles.form}>
        <div className={styles.uploadChoices}>
          <label className={styles.filePick}>
            <input type="file" ref={input => { input?.setAttribute('webkitdirectory', '') }} multiple disabled={busy !== null || Boolean(preview)} onChange={loadFiles} />
            <span><strong>选择日记文件夹</strong><small>一次导入，包含子文件夹</small></span>
          </label>
          <label className={styles.filePick}>
            <input type="file" accept=".txt,.md" multiple disabled={busy !== null || Boolean(preview)} onChange={loadFiles} />
            <span><strong>选择日记文件</strong><small>支持 .txt 和 .md，可多选、可追加</small></span>
          </label>
        </div>
        {fileNote && <p className={styles.note} role="status">{fileNote}</p>}
        {!pasting && <button type="button" className={styles.link} disabled={busy !== null || Boolean(preview)} onClick={() => setPasting(true)}>或粘贴一篇日记</button>}
        {pasting && (
          <div className={styles.form}>
            <label className={styles.field}>日记日期<input type="date" value={date} disabled={busy !== null} onChange={event => setDate(event.target.value)} /></label>
            <label className={styles.field}>日记正文<textarea rows={5} value={content} disabled={busy !== null} onChange={event => setContent(event.target.value)} /></label>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={busy !== null || !content.trim()} onClick={addPasted}>加入本批</button>
              <button type="button" className={styles.link} disabled={busy !== null} onClick={() => { setPasting(false); setContent('') }}>取消粘贴</button>
            </div>
          </div>
        )}
        {drafts.length > 0 && <details>
          <summary>查看或修改文件列表{undated > 0 && `（${undated} 篇日期未知，可留空）`}</summary>
          <div className={styles.fileList}>
            {drafts.map((entry, index) => ({ entry, index })).sort((a, b) => Number(Boolean(a.entry.date)) - Number(Boolean(b.entry.date))).map(({ entry, index }) => (
              <div className={styles.fileRow} key={entry.key}>
                <label className={styles.field}>
                  <span>{entry.filename ?? `粘贴的日记 ${index + 1}`}</span>
                  <input type="date" value={entry.date ?? ''} disabled={busy !== null || Boolean(preview)} onChange={event => {
                    const date = event.target.value || null
                    setDrafts(items => items.map(item => item.key === entry.key ? { ...item, date } : item))
                    clearPreview()
                  }} />
                </label>
                <button className={styles.link} type="button" disabled={busy !== null || Boolean(preview)} onClick={() => {
                  setDrafts(items => items.filter(item => item.key !== entry.key))
                  clearPreview()
                }}>移除</button>
              </div>
            ))}
          </div>
        </details>}
        <p className={styles.note}>本批 {drafts.length} 篇 · {total.toLocaleString()} 字符</p>
        <p className={styles.note}>综合分析会把整批日记及少量检索到的旧资料发送给已配置的模型 API。新建议的引文须来自本批日记；之后可带着分析继续长期对话。</p>
        <button type="button" disabled={busy !== null || !drafts.length || Boolean(preview) || Boolean(pasting && content.trim())} onClick={() => void saveSources()}>{busy === 'save' ? '正在保存…' : '仅保存到本地资料库'}</button>
        {saveNote && <p className={styles.note} role="status">{saveNote}</p>}
        <button className={styles.primary} type="submit" disabled={busy !== null || !drafts.length || Boolean(pasting && content.trim()) || Boolean(preview)}>
          {busy === 'analyze' ? '正在综合分析…' : busy === 'file' ? '正在读取文件…' : `综合分析${drafts.length ? ` ${drafts.length} 篇` : ''}`}
        </button>

        {busy === 'analyze' && <div className={styles.actions}>
          <p className={styles.note} role="status">{started
            ? (live.length ? `已收到 ${live.length} 条建议，内容还在继续返回…` : '已接收整批日记，等待 AI 返回第一条建议…')
            : '正在提交本批日记…'}</p>
          <button className={styles.link} type="button" onClick={() => analysis.current?.abort()}>取消分析</button>
        </div>}
      </form>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {(busy === 'analyze' && started || preview) && (
        <section className={styles.summaryPanel} aria-label="模型公开推理摘要">
          <h3>模型公开推理摘要</h3>
          {summary ? <p className={styles.summaryText}>{summary}</p> : (
            <p className={styles.note}>{preview ? '本次 API 未返回公开推理摘要。' : '如果 API 返回公开摘要，会在这里实时显示。'}</p>
          )}
        </section>
      )}
      {visible && (
        <section className={styles.preview}>
          <h3>{preview ? '综合分析结果' : '正在生成的主题条目'} · {visible.entries.length} 篇日记</h3>
          {preview && <>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={busy !== null} onClick={continueChat}>{busy === 'attach' ? '正在接入分析…' : '带着分析继续聊天'}</button>
              <button type="button" className={styles.link} onClick={onViewInbox}>查看收件箱</button>
              <button type="button" className={styles.link} onClick={() => { setDrafts([]); setPasting(false); setFileNote(''); clearPreview() }}>分析下一批</button>
            </div>
            <p className={styles.note}>原件已经保存在本地；分析建议已到收件箱，还没有写入百科。</p>
          </>}
          {!visible.suggestions.length ? (
            <p className={styles.note} role="status">没有发现可核对原话的百科建议。日记原件已保留。</p>
          ) : (
            <>
              {[...groups].map(([category, suggestions]) => (
                <section key={category} className={styles.theme}>
                  <h4>{diaryCategoryLabels[category] ?? category}</h4>
                  {suggestions.map(({ item, index }) => (
                    <div key={index} className={`${styles.suggestion} ${styles.fullSuggestion}`}>
                      <span>
                        <span className={styles.analysis}><strong>AI 归纳：</strong>{item.fact}</span>
                        {item.basis && <span className={styles.analysis}><strong>归纳依据：</strong>{item.basis}</span>}
                        {item.citations.map(({ source, quote }) => {
                          const entry = visible.entries[source - 1]
                          return <span key={JSON.stringify([source, quote])} className={styles.evidenceQuote}>
                            <span className={styles.sourceLabel}>日记原话 · {entry.date ? <time dateTime={entry.date}>{entry.date}</time> : '日期未知'} · {entry.filename ?? `日记 ${source}`}</span>
                            <span className={styles.quote}>{quote}</span>
                          </span>
                        })}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </>
          )}
        </section>
      )}
    </section>
  )
}
