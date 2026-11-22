import { useState } from 'react'
import { api, body, categoryName, Empty, EvidenceList, EventLinks, Field, Page, stamp, type Data, type Proposal, type Work } from './shared.js'
import { ArticleForm } from './Articles.js'
import { EventForm, eventFields } from './Events.js'
import styles from './Personal.module.css'

export const kindName = { event: '事件候选', article: '百科草稿', question: '待核对的判断' }
const stateName = { pending: '待审核', accepted: '已确认', dismissed: '已驳回', corrected: '已纠正' }
const originName = { diary: '日记分析', review: '复盘', chat: '长期对话' }
const append = (first: string, second: string) => first ? first.includes(second) ? first : `${first}\n\n${second}` : second
export function EventDraftEditor({ proposal: p, data, work, cancel, saved }: { proposal: Proposal; data: Data; work: Work; cancel: () => void; saved: (id: string) => void }) {
  const [target, setTarget] = useState(() => p.eventIds.length === 1 && data.events.some(e => e.id === p.eventIds[0]) ? p.eventIds[0] : '')
  const existing = data.events.find(e => e.id === target)
  const draft = p.status === 'corrected' ? undefined : p.eventDraft
  const facts = p.status === 'corrected' ? p.correction ?? p.content : p.content
  return <div className={styles.segment}><Field label="保存到哪里？"><select value={target} onChange={e => setTarget(e.target.value)}><option value="">新建事件</option>{data.events.map(e => <option key={e.id} value={e.id}>补充 · {e.title}</option>)}</select></Field>
    <EventForm key={target} initial={eventFields({ ...existing, title: existing?.title ?? p.title, date: existing?.date || draft?.date || '',
      cause: append(existing?.cause ?? '', draft?.cause ?? ''), facts: append(existing?.facts ?? '', facts), outcome: append(existing?.outcome ?? '', draft?.outcome ?? ''),
      analysis: append(existing?.analysis ?? '', p.basis) })} chapters={data.chapters} label={target ? '确认补充到同一个事件' : '确认新建事件'} actions={<button type="button" onClick={cancel}>取消</button>} onSave={async event => {
      const result = await work(() => api<{ id: string }>(`/proposals/${p.id}`, body({ action: 'event', event, target: target || undefined })), '事件及其原话已保存。')
      if (result) saved(result.id)
    }} />
  </div>
}
function ProposalCard({ p, data, work, openEvent, openArticle, openChat }: { p: Proposal; data: Data; work: Work; openEvent: (id: string) => void; openArticle: (id: string) => void; openChat: () => void }) {
  const [mode, setMode] = useState<'event' | 'article' | 'correct' | 'classify'>(), [target, setTarget] = useState(''), [correction, setCorrection] = useState('')
  const acceptedContent = p.status === 'corrected' ? p.correction ?? '' : p.content
  const existingArticle = data.articles.find(a => a.id === target && !a.deleted)
  function change(next?: typeof mode) { setMode(next); setTarget(next === 'article' && data.articles.some(a => a.id === p.articleId && !a.deleted) ? p.articleId ?? '' : next === 'event' && p.eventIds.length === 1 && data.events.some(e => e.id === p.eventIds[0]) ? p.eventIds[0] : '') }
  const route = `/proposals/${p.id}`
  return <article className={styles.card}>
    <p className={styles.kicker}>{stateName[p.status]} · {kindName[p.kind]} · {originName[p.origin]} · {stamp(p.createdAt)}</p><h2>{p.title}</h2>
    {(p.eventDraft?.date || p.eventDraft?.cause || p.eventDraft?.outcome) && p.kind === 'event' && <div className={styles.segment}>
      {p.eventDraft.date && <p>发生时间：{p.eventDraft.date}</p>}{p.eventDraft.cause && <p>起因：{p.eventDraft.cause}</p>}{p.eventDraft.outcome && <p>实际结果：{p.eventDraft.outcome}</p>}
    </div>}
    <div className={styles.segment}><h3>{p.kind === 'event' ? '经过（待核对）' : p.kind === 'article' ? '百科正文草稿' : '待验证的问题'}</h3><p className={styles.preserve}>{p.content}</p></div>
    {p.basis && <div className={styles.segment}><h3>为什么提出</h3><p className={styles.preserve}>{p.basis}</p></div>}
    {p.counterpoint && <div className={styles.segment}><h3>反例或另一种解释</h3><p className={styles.preserve}>{p.counterpoint}</p></div>}
    {p.correction && <div className={styles.segment}><h3>我的纠正</h3><p className={styles.preserve}>{p.correction}</p></div>}
    <EventLinks ids={p.eventIds} open={openEvent} events={data.events} /><EvidenceList evidence={p.evidence} />
    <div className={styles.actions}>
      <button type="button" onClick={async () => { if (await work(() => api('/focus', body({ id: p.id })))) openChat() }}>回到长期对话核对</button>
      {(p.status === 'pending' || p.status === 'corrected') && <><button type="button" className={styles.primary} onClick={() => change(p.kind === 'event' ? 'event' : p.kind === 'article' ? 'article' : 'correct')}>{p.kind === 'event' ? '核对并记录事件' : p.kind === 'article' ? '编辑百科草稿' : '回应这个判断'}</button><button type="button" onClick={() => change(mode === 'classify' ? undefined : 'classify')}>更改类型</button><button type="button" onClick={() => { change('correct'); setCorrection(p.correction ?? '') }}>纠正判断</button><button type="button" onClick={async () => { if (await work(() => api(route, body({ action: 'dismiss' })), '已驳回，未写入百科。')) change() }}>驳回</button></>}
    </div>
    {mode === 'classify' && <div className={styles.segment}><h3>这条内容更适合归到哪里？</h3><div className={styles.actions}>{(['event', 'article', 'question'] as const).map(kind => <button key={kind} type="button" disabled={p.kind === kind} onClick={async () => {
      if (await work(() => api(route, body({ action: 'classify', kind })), '已更改类型，原话和来源保留。')) change()
    }}>{kindName[kind]}</button>)}</div><p className={styles.muted}>改类型不会写入事件簿或百科，确认草稿后才会保存。</p></div>}
    {mode === 'correct' && <form className={styles.form} onSubmit={async e => { e.preventDefault(); if (await work(() => api(route, body({ action: 'correct', correction })), '已保存你的纠正。')) change() }}><Field label="哪里不对？应该怎么理解？"><textarea required maxLength={1500} value={correction} onChange={e => setCorrection(e.target.value)} /></Field><div className={styles.actions}><button type="submit" className={styles.primary}>保存纠正</button><button type="button" onClick={() => change()}>取消</button></div></form>}
    {mode === 'event' && <EventDraftEditor proposal={p} data={data} work={work} cancel={() => change()} saved={id => { change(); openEvent(id) }} />}
    {mode === 'article' && <div className={styles.segment}><Field label="写到哪个条目？"><select value={target} onChange={e => setTarget(e.target.value)}><option value="">新建条目</option>{data.articles.filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>修订 · {a.title}</option>)}</select></Field>
      {existingArticle && <details className={styles.details}><summary>查看旧版正文</summary><p className={styles.preserve}>{existingArticle.fact}</p></details>}
      <ArticleForm key={target} data={data} initial={{ title: existingArticle?.title ?? p.title, category: existingArticle?.category ?? p.category, fact: acceptedContent || existingArticle?.fact || '', eventIds: [...new Set([...(existingArticle?.eventIds ?? []), ...p.eventIds])].slice(0, 12), reason: '' }} actions={<button type="button" onClick={() => change()}>取消</button>} onSave={async article => { const r = await work(() => api<{ id: string }>(route, body({ action: 'article', article, target: target || undefined })), '已确认到百科，修订历史已保留。'); if (r) { change(); openArticle(r.id) } }} />
    </div>}
  </article>
}
export default function Inbox({ data, target, open, work, openEvent, openArticle, openChat }: { data: Data; target?: string; open: (id?: string) => void; work: Work; openEvent: (id: string) => void; openArticle: (id: string) => void; openChat: () => void }) {
  const [filter, setFilter] = useState<'pending' | 'handled'>('pending')
  const p = data.proposals.find(p => p.id === target)
  const list = data.proposals.filter(p => (p.status === 'pending') === (filter === 'pending')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <Page kicker="编辑台 / 收件箱" title="待核对的材料" hint="聊天、日记和复盘的建议先到这里。你可以补到同一件事、修订百科，或告诉 AI 它哪里理解错了。">
    <div className={styles.actions}><button type="button" aria-pressed={filter === 'pending'} onClick={() => { setFilter('pending'); open() }}>待审核 · {data.proposals.filter(p => p.status === 'pending').length}</button><button type="button" aria-pressed={filter === 'handled'} onClick={() => { setFilter('handled'); open() }}>已处理</button></div>
    <div className={styles.split}><div className={styles.list}>{list.length ? list.map(p => <button type="button" key={p.id} aria-current={target === p.id ? 'true' : undefined} onClick={() => open(p.id)}><small>{kindName[p.kind]} · {p.kind === 'article' ? categoryName(p.category) : originName[p.origin]}</small><strong>{p.title}</strong></button>) : <Empty>这里暂时没有建议。</Empty>}</div>
    {p ? <ProposalCard key={p.id} p={p} data={data} work={work} openEvent={openEvent} openArticle={openArticle} openChat={openChat} /> : <Empty>选一条建议，查看依据和原话，再决定如何处理。</Empty>}</div>
  </Page>
}
