import { mobileClient } from '../../lib/mobileAccess.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import Articles from './Articles.js'
import Profile from './Profile.js'
import Contexts from './Contexts.js'
import DiaryLibrary from './DiaryLibrary.js'
import JournalWrite from './JournalWrite.js'
import { useJournalAnalysis } from './JournalAnalysis.js'
import Dreams from './Dreams.js'
import Events from './Events.js'
import Inbox from './Inbox.js'
import LongChat from './LongChat.js'
import Settings from './Settings.js'
import LifeBook from './LifeBook.js'
import { api, body, Empty, EvidenceList, Field, Page, type Data, type Evidence, type OpenComparison, type Tab, type Work } from './shared.js'
import styles from './Personal.module.css'

export const tabs: { id: Tab; title: string; group: 'primary' | 'archive' | 'system' }[] = [
  { id: 'overview', title: '关于我', group: 'primary' },
  { id: 'book', title: '人生书', group: 'primary' },
  { id: 'chat', title: '长期对话', group: 'primary' },
  { id: 'journal', title: '写日记', group: 'primary' },
  { id: 'inbox', title: '收件箱', group: 'primary' },
  { id: 'articles', title: '我的百科', group: 'archive' },
  { id: 'events', title: '事件簿', group: 'archive' },
  { id: 'contexts', title: '人物与环境', group: 'archive' },
  { id: 'library', title: '日记资料库', group: 'archive' },
  { id: 'dreams', title: '梦境簿', group: 'archive' },
  { id: 'settings', title: '设置', group: 'system' },
]
type Search = { mode: 'keyword' | 'hybrid'; hits: { id: string; sourceId: string; title: string; kind: 'event' | 'article' | 'context' | 'analysis'; text: string; evidence: Evidence[] }[] }
function ArchiveTools({ data, go, legacy, work, busy }: { data: Data; go: (tab: Tab, id?: string) => void; legacy: () => void; work: Work; busy: boolean }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState<Search>(), [looking, setLooking] = useState(false), [gap, setGap] = useState<number>()
  return <div className={styles.page}>
    <form className={`${styles.card} ${styles.form}`} onSubmit={async e => { e.preventDefault(); setLooking(true); try { const r = await work(() => api<Search>(`/search?q=${encodeURIComponent(query.trim())}`)); if (r) setResult(r) } finally { setLooking(false) } }}>
      <div className={styles.search}><Field label="查找旧事与认识"><input value={query} maxLength={300} placeholder="例如：哪几次我拒绝了长期承诺？" onChange={e => setQuery(e.target.value)} /></Field><button type="submit" disabled={looking || !query.trim()}>{looking ? '正在查找…' : '搜索'}</button></div>
      {result && <div className={styles.stack}><small>{result.mode === 'hybrid' ? '本地语义＋关键词' : '关键词检索'}</small>{result.hits.length ? result.hits.map(hit => <div className={styles.compare} key={hit.id}><button className={styles.link} type="button" onClick={() => go(hit.kind === 'event' ? 'events' : hit.kind === 'article' ? 'articles' : hit.kind === 'context' ? 'contexts' : 'inbox', hit.sourceId)}>{hit.title}</button><p className={styles.preserve}>{hit.text.slice(0, 240)}{hit.text.length > 240 && '…'}</p><EvidenceList evidence={hit.evidence} /></div>) : <p>没有找到相关材料。试试事情、人物或主题的另一种说法。</p>}</div>}
    </form>
    <section className={styles.card}><h2>把人生书带走</h2><p className={styles.muted}>导出章节、时间线、所引原话、百科和修订记录。梦境单独导出，不混入人生书。</p><div className={styles.actions}><a className={styles.button} href="/api/personal/book.zip">导出人生书（Markdown ZIP）</a><button type="button" onClick={legacy}>原版资料与简历</button></div></section>
    <section className={styles.card}><h2>从旧事找值得追问的问题</h2><div className={styles.actions}><button disabled={busy || data.events.length < 2} type="button" onClick={async () => { const r = await work(() => api<{ count: number }>('/gaps', body({})), '缺口分析已完成。'); if (r) setGap(r.count) }}>找值得追问的缺口</button>{gap !== undefined && <p className={styles.muted}>已新增 {gap} 条待聊的问题。</p>}</div></section>
  </div>
}
export default function PersonalWorkspace({ tab, active, setTab, legacy, onInboxCount }: { tab: Tab; active: boolean; setTab: (tab: Tab) => void; legacy: () => void; onInboxCount: (count: number) => void }) {
  const [data, setData] = useState<Data>(), [error, setError] = useState(''), [status, setStatus] = useState(''), [pending, setPending] = useState(0)
  const [targets, setTargets] = useState<Partial<Record<Tab, string>>>({})
  const [chatDraft, setChatDraft] = useState<{ key: number; text: string }>()
  const discussJournal = (text: string) => { setChatDraft({ key: Date.now(), text }); setTab('chat') }
  const [allowDiary, setDiaryPreference] = useState(() => {
    try { return (localStorage.getItem('becoming-me:diary-recall') ?? (mobileClient ? 'off' : 'on')) === 'on' } catch { return !mobileClient }
  })
  const setAllowDiary = (value: boolean) => {
    setDiaryPreference(value)
    try { localStorage.setItem('becoming-me:diary-recall', value ? 'on' : 'off') } catch { /* preference still applies in this session */ }
  }
  const inboxCount = (data?.proposals.filter(p => p.status === 'pending' && !p.originId?.startsWith('profile:')).length ?? 0) + (data?.contextSuggestions.filter(s => s.status === 'pending').length ?? 0)
  useEffect(() => { onInboxCount(inboxCount) }, [inboxCount, onInboxCount])
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++sequence.current
    try { const result = await api<Data>(); if (version === sequence.current) { setData(result); setError('') } }
    catch (e) { if (version === sequence.current) setError((e as Error).message) }
  }, [])
  useEffect(() => { if (active) void refresh() }, [active, refresh])
  const [journalVersion, setJournalVersion] = useState(0)
  const journalAnalysis = useJournalAnalysis(() => { setJournalVersion(v => v + 1); void refresh() })
  const work: Work = async (task, text) => {
    setPending(x => x + 1); setError(''); setStatus('')
    try { const result = await task(); if (text) setStatus(text); await refresh(); return result }
    catch (e) { setError((e as Error).message); return undefined }
    finally { setPending(x => x - 1) }
  }
  const go = (tab: Tab, id?: string) => { setTargets(p => ({ ...p, [tab]: id })); setTab(tab) }
  const discuss: OpenComparison = focus => { void (async () => {
    if (await work(() => api('/focus', body({ comparison: focus })))) go('chat')
  })() }
  return <div hidden={!active} className={styles.workspace}>
    {pending > 0 && <p role="status" className={styles.notice}>正在处理…</p>}
    {error && <p role="alert" className={styles.error}>{error} <button className={styles.link} type="button" onClick={() => void refresh()}>重载资料</button></p>}
    {status && <p role="status" className={styles.notice}>{status}</p>}
    {!data && tab !== 'chat' && tab !== 'settings' && tab !== 'library' && tab !== 'journal' && !error && <Empty>正在打开人生书…</Empty>}
    {active && tab === 'settings' && (mobileClient
      ? <Page kicker="成我 / 设置" title="手机连接" hint="你正在使用电脑上的同一份资料。模型、备份和设备管理请在电脑操作。">
        <section className={styles.card}><h2>手机上的日记检索</h2>
          <label className={styles.actions}><input type="checkbox" checked={allowDiary} onChange={e => setAllowDiary(e.target.checked)} />允许从手机发起的对话按需调取日记原文</label>
        </section>
        <section className={styles.card}><h2>当前设备</h2><p className={styles.muted}>退出将撤销本浏览器的授权，下次需要重新配对。</p>
          <form method="post" action="/mobile-connect/logout"><button type="submit">退出本设备</button></form>
        </section>
      </Page>
      : <Settings allowDiary={allowDiary} setAllowDiary={setAllowDiary} openDiaryLibrary={() => go('library')} />)}
    <div hidden={!active || tab !== 'journal'}><JournalWrite analysis={journalAnalysis} onSaved={() => setJournalVersion(v => v + 1)} openLibrary={() => go('library')} openInbox={() => go('inbox')} discussJournal={discussJournal} /></div>
    {active && tab === 'library' && <DiaryLibrary openChat={() => { void refresh(); go('chat') }} onSaved={() => setJournalVersion(v => v + 1)} openWrite={() => go('journal')} openInbox={() => go('inbox')} analysis={journalAnalysis} version={journalVersion} />}
    <LongChat allowDiary={allowDiary} setAllowDiary={setAllowDiary} hidden={tab !== 'chat' || !active} data={data} work={work} changed={refresh} draftPrompt={chatDraft} openDiary={() => go('library')} openEvent={id => go('events', id)} openArticle={id => go('articles', id)} openProfile={() => go('overview')} />
    {data && <>
      {tab === 'overview' && <Profile report={data.profileReport} go={go} work={work} busy={pending > 0} />}
      <div hidden={tab !== 'book'}><LifeBook data={data} target={targets.book} open={id => go('book', id)} openEvent={id => go('events', id)} openArticle={id => go('articles', id)} openContext={id => go('contexts', id)} discuss={discuss} busy={pending > 0} />{tab === 'book' && <ArchiveTools data={data} go={go} work={work} busy={pending > 0} legacy={legacy} />}</div>
      <div hidden={tab !== 'inbox'}><Inbox data={data} work={work} target={targets.inbox} open={id => go('inbox', id)} openEvent={id => go('events', id)} openArticle={id => go('articles', id)} openChat={() => go('chat')} openCard={id => go('contexts', id || undefined)} /></div>
      <div hidden={tab !== 'events'}><Events data={data} work={work} discuss={discuss} target={targets.events} open={id => go('events', id)} openArticle={id => go('articles', id)} openInbox={() => go('inbox')} openContext={id => go('contexts', id)} busy={pending > 0} /></div>
      <div hidden={tab !== 'articles'}><Articles data={data} work={work} discuss={discuss} discussQuestion={id => { void (async () => { if (await work(() => api('/focus', body({ id })))) go('chat') })() }} target={targets.articles} open={id => go('articles', id)} openEvent={id => go('events', id)} openInbox={() => go('inbox')} busy={pending > 0} /></div>
      <div hidden={tab !== 'contexts'}><Contexts data={data} target={targets.contexts} work={work} open={id => go('contexts', id)} openEvent={id => go('events', id)} openArticle={id => go('articles', id)} discuss={discuss} busy={pending > 0} /></div>
      <div hidden={tab !== 'dreams'}><Dreams data={data} work={work} openChat={() => go('chat')} busy={pending > 0} /></div>
    </>}
  </div>
}
