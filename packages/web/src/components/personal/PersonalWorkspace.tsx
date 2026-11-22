import { useCallback, useEffect, useRef, useState } from 'react'
import Articles from './Articles.js'
import Dreams from './Dreams.js'
import Events from './Events.js'
import Inbox, { kindName } from './Inbox.js'
import LongChat from './LongChat.js'
import LifeBook, { BookPreview } from './LifeBook.js'
import { api, body, categoryName, Empty, EvidenceList, Field, Page, stamp, type Data, type Evidence, type OpenComparison, type Tab, type Work } from './shared.js'
import styles from './Personal.module.css'

export const tabs: { id: Tab; title: string }[] = [
  { id: 'overview', title: '总览' }, { id: 'book', title: '人生书' }, { id: 'chat', title: '长期对话' }, { id: 'inbox', title: '收件箱' },
  { id: 'events', title: '事件簿' }, { id: 'articles', title: '我的百科' }, { id: 'dreams', title: '梦境簿' },
]
type Search = { mode: 'keyword' | 'hybrid'; hits: { id: string; sourceId: string; title: string; kind: 'event' | 'article' | 'analysis'; text: string; evidence: Evidence[] }[] }
function Overview({ data, go, openDiary, legacy, work, busy }: { data: Data; go: (tab: Tab, id?: string) => void; openDiary: () => void; legacy: () => void; work: Work; busy: boolean }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState<Search>(), [looking, setLooking] = useState(false), [gap, setGap] = useState<number>()
  const pending = data.proposals.filter(p => p.status === 'pending').sort((a, b) => Number(b.kind === 'question') - Number(a.kind === 'question') || b.createdAt.localeCompare(a.createdAt))
  const recent = [...data.articles].filter(a => !a.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
  return <Page kicker="个人百科 / 工作台" title="总览" hint="把自己的叙述整理成一部可回看的历史。事件保留当时的原话，百科记录后来核对过的认识。" actions={<><button className={styles.primary} type="button" onClick={() => go('chat')}>继续聊天</button><button type="button" onClick={openDiary}>分析日记</button></>}>
    <BookPreview data={data} open={id => go('book', id)} />
    <form className={`${styles.card} ${styles.form}`} onSubmit={async e => { e.preventDefault(); setLooking(true); try { const r = await work(() => api<Search>(`/search?q=${encodeURIComponent(query.trim())}`)); if (r) setResult(r) } finally { setLooking(false) } }}>
      <div className={styles.search}><Field label="查找旧事与认识"><input value={query} maxLength={300} placeholder="例如：哪几次我拒绝了长期承诺？" onChange={e => setQuery(e.target.value)} /></Field><button type="submit" disabled={looking || !query.trim()}>{looking ? '正在查找…' : '搜索'}</button></div>
      {result && <div className={styles.stack}><small>{result.mode === 'hybrid' ? '本地语义＋关键词' : '关键词检索'}</small>{result.hits.length ? result.hits.map(hit => <div className={styles.compare} key={hit.id}><button className={styles.link} type="button" onClick={() => go(hit.kind === 'event' ? 'events' : hit.kind === 'article' ? 'articles' : 'inbox', hit.sourceId)}>{hit.title}</button><p className={styles.preserve}>{hit.text.slice(0, 240)}{hit.text.length > 240 && '…'}</p><EvidenceList evidence={hit.evidence} /></div>) : <p>没有找到相关材料。试试事情、人物或主题的另一种说法。</p>}</div>}
    </form>
    <div className={styles.grid}>
      <section className={styles.card}><p className={styles.kicker}>需要你确认</p><h2>待核对 · {pending.length}</h2><div className={styles.list}>{pending.slice(0, 5).map(p => <button type="button" key={p.id} onClick={() => go('inbox', p.id)}><small>{kindName[p.kind]}</small><strong>{p.title}</strong></button>)}</div>{!pending.length && <p className={styles.muted}>日记、复盘和聊天产生的建议会先出现在这里。</p>}
        <div className={styles.actions}><button type="button" onClick={() => go('inbox')}>打开收件箱</button><button disabled={busy || data.events.length < 2} type="button" onClick={async () => { const r = await work(() => api<{ count: number }>('/gaps', body({})), '缺口分析已完成。'); if (r) setGap(r.count) }}>找值得追问的缺口</button></div>{gap !== undefined && <p className={styles.muted}>已新增 {gap} 条待聊的问题。</p>}
      </section>
      <section className={styles.card}><p className={styles.kicker}>会变化的认识</p><h2>最近修订</h2><div className={styles.list}>{recent.map(a => <button type="button" key={a.id} onClick={() => go('articles', a.id)}><small>{categoryName(a.category)}{Date.parse(a.updatedAt) ? ` · ${stamp(a.updatedAt)}` : ''}</small><strong>{a.title}</strong></button>)}</div>{!recent.length && <p className={styles.muted}>确认的百科条目及后续修订会出现在这里。</p>}
        <div className={styles.actions}><button type="button" onClick={() => go('articles')}>查阅百科</button><button type="button" onClick={() => go('events')}>看事件时间线 · {data.events.length}</button></div>
      </section>
    </div>
    <section className={styles.card}><h2>把人生书带走</h2><p className={styles.muted}>导出章节、时间线、所引原话、百科和修订记录。梦境单独导出，不混入人生书。</p><div className={styles.actions}><a className={styles.button} href="/api/personal/book.zip">导出人生书（Markdown ZIP）</a><button type="button" onClick={legacy}>原版资料与简历</button></div></section>
  </Page>
}
export default function PersonalWorkspace({ tab, active, setTab, openDiary, legacy, refreshKey }: { tab: Tab; active: boolean; setTab: (tab: Tab) => void; openDiary: () => void; legacy: () => void; refreshKey: number }) {
  const [data, setData] = useState<Data>(), [error, setError] = useState(''), [status, setStatus] = useState(''), [pending, setPending] = useState(0)
  const [targets, setTargets] = useState<Partial<Record<Tab, string>>>({})
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++sequence.current
    try { const result = await api<Data>(); if (version === sequence.current) { setData(result); setError('') } }
    catch (e) { if (version === sequence.current) setError((e as Error).message) }
  }, [])
  useEffect(() => { if (active) void refresh() }, [active, refreshKey, refresh])
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
    {!data && tab !== 'chat' && !error && <Empty>正在打开人生书…</Empty>}
    <LongChat hidden={tab !== 'chat' || !active} data={data} work={work} changed={refresh} openDiary={openDiary} />
    {data && <>
      <div hidden={tab !== 'overview'}><Overview data={data} go={go} work={work} busy={pending > 0} openDiary={openDiary} legacy={legacy} /></div>
      <div hidden={tab !== 'book'}><LifeBook data={data} target={targets.book} open={id => go('book', id)} openEvent={id => go('events', id)} /></div>
      <div hidden={tab !== 'inbox'}><Inbox data={data} work={work} target={targets.inbox} open={id => go('inbox', id)} openEvent={id => go('events', id)} openArticle={id => go('articles', id)} openChat={() => go('chat')} /></div>
      <div hidden={tab !== 'events'}><Events data={data} work={work} discuss={discuss} target={targets.events} open={id => go('events', id)} openArticle={id => go('articles', id)} openInbox={() => go('inbox')} busy={pending > 0} /></div>
      <div hidden={tab !== 'articles'}><Articles data={data} work={work} discuss={discuss} target={targets.articles} open={id => go('articles', id)} openEvent={id => go('events', id)} openInbox={() => go('inbox')} busy={pending > 0} /></div>
      <div hidden={tab !== 'dreams'}><Dreams data={data} work={work} openChat={() => go('chat')} busy={pending > 0} /></div>
    </>}
  </div>
}
