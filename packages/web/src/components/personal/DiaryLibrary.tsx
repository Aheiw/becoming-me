import { useEffect, useRef, useState } from 'react'
import { interviewHistoryRequest, type InterviewDiaryBatch, type InterviewDiaryDetails, type InterviewHistory } from '../../lib/interviewHistory.js'
import DiaryImport from './DiaryImport.js'
import JournalCalendar from './JournalCalendar.js'
import { JournalAnalysisNotice, type JournalAnalysis } from './JournalAnalysis.js'
import { api, body, Empty, Field, Page, stamp } from './shared.js'
import styles from './Personal.module.css'

export default function DiaryLibrary({ openWrite, openInbox, openChat, onSaved, analysis, version }: { openWrite: () => void; openInbox: () => void; openChat: () => void; onSaved: () => void; analysis: JournalAnalysis; version: number }) {
  const [batches, setBatches] = useState<InterviewDiaryBatch[]>()
  const [batchId, setBatchId] = useState('')
  const [details, setDetails] = useState<InterviewDiaryDetails>()
  const [index, setIndex] = useState(0)
  const reader = useRef<HTMLElement>(null), shouldFocus = useRef(false)
  const [listError, setListError] = useState(''), [readError, setReadError] = useState('')
  const [importOpen, setImportOpen] = useState(false), [actionError, setActionError] = useState('')
  const [listAttempt, retryList] = useState(0), [readAttempt, retryRead] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setListError('')
    interviewHistoryRequest<InterviewHistory>('', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setBatches(result.diaries)
    }).catch(err => { if (!controller.signal.aborted) setListError((err as Error).message) })
    return () => controller.abort()
  }, [listAttempt, version])

  useEffect(() => {
    if (!batchId) return
    const controller = new AbortController()
    interviewHistoryRequest<InterviewDiaryDetails>(`/diaries/${encodeURIComponent(batchId)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setDetails(result)
    }).catch(err => { if (!controller.signal.aborted) setReadError((err as Error).message) })
    return () => controller.abort()
  }, [batchId, readAttempt])

  useEffect(() => {
    if ((details || readError) && shouldFocus.current) { reader.current?.focus(); shouldFocus.current = false }
  }, [details, readError])
  function openEntry(id: string, i = 0, fromCalendar = false) {
    if (id !== batchId) {
      shouldFocus.current = fromCalendar
      setDetails(undefined); setReadError(''); setBatchId(id)
    } else if (fromCalendar) {
      if (details || readError) reader.current?.focus()
      else shouldFocus.current = true
    }
    setIndex(i)
  }
  const pending = batches?.filter(item => !item.hasAnalysis) ?? []
  const pendingEntries = pending.reduce((sum, item) => sum + item.count, 0)
  const batch = batches?.find(item => item.id === batchId)
  const entry = details?.entries[index]
  const titleFor = (filename: string | null, i: number) => filename || `第 ${i + 1} 篇日记`

  return <Page kicker="个人档案 / 原始资料" title="日记资料库" hint="查看以前保存的日记。原文和 AI 分析分开，打开原文不会调用 AI。" actions={<><button type="button" className={styles.primary} onClick={openWrite}>写日记</button><button type="button" onClick={() => setImportOpen(open => !open)}>导入日记</button></>}>
    {importOpen && <DiaryImport busy={analysis.busy} cancel={() => setImportOpen(false)} saved={(id, immediately) => {
      setImportOpen(false); onSaved(); openEntry(id); if (immediately) void analysis.start(id)
    }} />}
    <section className={`${styles.card} ${styles.bookHeading}`} aria-label="待分析的日记">
      <div><h2>待分析{batches ? ` · ${pendingEntries} 篇` : ''}</h2><p className={styles.muted}>跳过已有分析的日记，结果进入收件箱。</p></div>
      <button type="button" disabled={!pending.length || analysis.busy} onClick={() => void analysis.start()}>分析全部待分析</button>
    </section>
    <JournalAnalysisNotice analysis={analysis} openInbox={openInbox} />
    <JournalCalendar version={version} openEntry={(id, i) => openEntry(id, i, true)} />
    {listError ? <p role="alert" className={styles.error}>{listError} <button type="button" onClick={() => { setListError(''); retryList(n => n + 1) }}>重试</button></p>
      : !batches ? <p role="status" className={styles.muted}>正在读取导入记录…</p>
      : !batches.length ? <Empty>还没有存入资料库的日记。导入后可选择「仅保存到本地资料库」，不用先做分析。</Empty>
      : <div className={styles.bookLayout}>
        <aside className={`${styles.card} ${styles.bookNav}`} aria-label="已保存的日记批次">
          <h2>保存记录 · {batches.length}</h2>
          <div className={styles.list}>{batches.map(item => <button type="button" key={item.id} aria-current={item.id === batchId ? 'true' : undefined} onClick={() => openEntry(item.id)}><strong>{item.filename || '未命名日记'}</strong><small>{item.count} 篇 · {stamp(item.createdAt)} · {item.hasAnalysis ? '已有分析' : '待分析'}{item.origin === 'journal' ? ' · 网页写作' : item.origin === 'import' ? ' · 导入' : ''}</small></button>)}</div>
        </aside>
        <section className={`${styles.card} ${styles.bookPaper}`} aria-label="日记原文" tabIndex={-1} ref={reader}>
          {!batch ? <Empty>选择一批日记，再打开想读的那一篇。</Empty>
            : readError ? <p role="alert" className={styles.error}>{readError} <button type="button" onClick={() => { setReadError(''); retryRead(n => n + 1) }}>重试</button></p>
            : !details ? <p role="status" className={styles.muted}>正在读取日记…</p>
            : !entry ? <Empty>这一批没有可查看的日记。</Empty>
            : <>
              {details.entries.length > 1 && <Field label="选择篇目"><select value={index} onChange={e => setIndex(Number(e.target.value))}>
                {details.entries.map((item, i) => <option value={i} key={i}>{i + 1}. {titleFor(item.filename, i)}{item.date ? ` · ${item.date}` : ''}</option>)}
              </select></Field>}
              <header><p className={styles.kicker}>{entry.date || '写作日期未知'}</p><h2>{titleFor(entry.filename, index)}</h2></header>
              <div className={styles.actions}>
                {!batch.hasAnalysis && <button type="button" disabled={analysis.busy} onClick={() => void analysis.start(batch.id)}>分析这批日记</button>}
                {batch.hasAnalysis && <button type="button" onClick={async () => {
                  setActionError(''); try { await api('/focus', body({ diaryId: batch.id })); openChat() } catch (err) { setActionError((err as Error).message) }
                }}>带着分析继续聊</button>}
              </div>
              {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
              <div className={styles.preserve}>{entry.content}</div>
            </>}
        </section>
      </div>}
  </Page>
}
