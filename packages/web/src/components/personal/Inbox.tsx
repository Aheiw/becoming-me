import ContextInbox from './ContextInbox.js'
import { useRef, useState } from 'react'
import { chapterFor, findArticleTarget } from '../../../../server/src/personal/articleTopics.js'
import { groupArticleProposals, type ProposalThemeGroup } from '../../../../server/src/personal/inboxGroups.js'
import { api, body, categoryName, Empty, EvidenceList, EventLinks, Field, Page, stamp, type Data, type Proposal, type Work } from './shared.js'
import { ArticleForm, type ArticleFields } from './Articles.js'
import { mentionedDiaryCards } from '../../../../server/src/personal/contextEvents.js'
import { EventForm, eventFields, type EventFields } from './Events.js'
import styles from './Personal.module.css'

export const kindName = { event: '事件候选', article: '百科草稿', question: '待核对的判断' }
const stateName = { pending: '待审核', accepted: '已确认', dismissed: '已驳回', corrected: '已纠正' }
const originName = { diary: '日记分析', review: '复盘', chat: '长期对话' }
const append = (first: string, second: string) => !first ? second : !second || first.includes(second) ? first : `${first}\n\n${second}`
const draftContent = (p: Proposal) => p.status === 'corrected' ? p.correction ?? p.content : p.content
const eventTarget = (p: Proposal, data: Data) => p.eventIds.length === 1 ? data.events.find(e => e.id === p.eventIds[0]) : undefined
const articleTarget = (p: Proposal, data: Data) => {
  const active = data.articles.filter(a => !a.deleted)
  const target = findArticleTarget(active, p)
  return active.find(a => a.id === target?.id)
}
function eventDraft(p: Proposal, data: Data, existing?: Data['events'][number]) {
  const draft = p.status === 'corrected' ? undefined : p.eventDraft
  return eventFields({ ...existing, title: existing?.title ?? p.title, date: existing?.date || draft?.date || '',
    cause: append(existing?.cause ?? '', draft?.cause ?? ''), facts: append(existing?.facts ?? '', draftContent(p)),
    outcome: append(existing?.outcome ?? '', draft?.outcome ?? ''), analysis: append(existing?.analysis ?? '', p.basis),
    contextIds: existing ? data.contexts.filter(card => card.eventIds.includes(existing.id)).map(card => card.id) : [] })
}
function articleDraft(p: Proposal, existing?: Data['articles'][number]): ArticleFields {
  return { title: existing?.title ?? p.title, category: existing?.category ?? p.category, chapter: existing?.chapter ?? p.chapter, fact: existing && (p.operation !== 'revise' || existing.id !== p.articleId) ? append(existing.fact, draftContent(p)) : draftContent(p),
    limits: append(existing?.limits ?? '', p.counterpoint), eventIds: [...new Set([...(existing?.eventIds ?? []), ...p.eventIds])], reason: p.basis.slice(0, 500), version: existing?.version }
}

type SaveAction = { action: 'event'; target?: string; event: EventFields } | { action: 'article'; target?: string; article: ArticleFields; quick?: boolean }
type Action = SaveAction | { action: 'dismiss' } | { action: 'classify'; kind: Proposal['kind'] } | { action: 'correct'; correction: string }
type Receipt = { id: string; kind: SaveAction['action'] }

export function ProposalCard({ p, data, work, openEvent, openArticle, openChat, compact, onSaved }: { p: Proposal; data: Data; work: Work; openEvent: (id: string) => void; openArticle: (id: string) => void; openChat?: () => void; compact?: boolean; onSaved?: (receipt: Receipt) => void }) {
  const [mode, setMode] = useState<'event' | 'article' | 'correct' | 'classify'>(), [target, setTarget] = useState(''), [correction, setCorrection] = useState('')
  const [busy, setBusy] = useState(false), [receipt, setReceipt] = useState<Receipt>()
  const inFlight = useRef(false)
  const event = eventTarget(p, data), article = articleTarget(p, data)
  const writable = p.status === 'pending' || p.status === 'corrected'
  const existingArticle = data.articles.find(a => a.id === target && !a.deleted)
  const draft = p.kind === 'event' && p.status !== 'corrected' ? p.eventDraft : undefined
  const missingTarget = p.kind === 'article' && !!p.articleId && !article
  const staleRevision = p.kind === 'article' && p.operation === 'revise' && (!p.baseVersion || p.baseVersion !== article?.version)
  const canSave = !missingTarget && !staleRevision && p.kind !== 'question' && !!p.title.trim() && !!draftContent(p).trim()
  const eventLabel = event ? '确认补充事件' : '确认保存事件'
  const articleLabel = article ? p.operation === 'revise' ? '确认修订百科' : '确认补到原条目' : '确认保存百科'
  function change(next?: typeof mode) {
    setMode(next)
    setTarget(next === 'article' ? article?.id ?? '' : next === 'event' ? event?.id ?? '' : '')
  }
  async function act(action: Action, message: string) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try {
      const result = await work(() => api<{ id: string }>(`/proposals/${p.id}`, body(action)), message)
      if (!result) return
      change()
      if (action.action === 'event' || action.action === 'article') {
        const saved = { id: result.id, kind: action.action }
        setReceipt(saved); onSaved?.(saved)
      }
    } finally { setBusy(false); inFlight.current = false }
  }
  function saveEvent(event: EventFields, target?: string) {
    return act({ action: 'event', event, target }, '事件及其原话已保存。')
  }
  function saveArticle(article: ArticleFields, target?: string, quick = false) {
    return act({ action: 'article', article, target, quick }, '百科已保存，修订历史已保留。')
  }
  const preview = <>
    {(draft?.date || draft?.cause || draft?.outcome) && <div className={styles.segment}>
      {draft.date && <p>发生时间：{draft.date}</p>}{draft.cause && <p>起因：{draft.cause}</p>}{draft.outcome && <p>实际结果：{draft.outcome}</p>}
    </div>}
    {missingTarget && <p>原条目已不在正式百科中。请先恢复它，或明确选择其他条目。</p>}
    {article && <p className={styles.muted}>相关百科：{chapterFor(article).name} / <button type="button" onClick={() => openArticle(article.id)}>{article.title}</button></p>}
    {article && p.operation === 'revise' && <p className={styles.preserve}><strong>当前正文：</strong>{article.fact}</p>}
    <div className={styles.segment}><h3>{p.kind === 'event' ? '经过（待核对）' : p.kind === 'article' ? article && p.operation !== 'revise' ? '准备补充的内容' : '百科正文草稿' : '待验证的解释'}</h3><p className={styles.preserve}>{draftContent(p)}</p></div>
    {p.basis && <div className={styles.segment}><h3>为什么提出</h3><p className={styles.preserve}>{p.basis}</p></div>}
    {p.counterpoint && <div className={styles.segment}><h3>反例或另一种解释</h3><p className={styles.preserve}>{p.counterpoint}</p></div>}
    {p.correction && <div className={styles.segment}><h3>原建议</h3><p className={styles.preserve}>{p.content}</p></div>}
    <EventLinks ids={p.eventIds} open={openEvent} events={data.events} /><EvidenceList evidence={p.evidence} />
  </>
  return <article className={compact ? styles.chatSuggestion : styles.card} aria-busy={busy}>
    {compact ? <strong>{stateName[p.status]} · {kindName[p.kind]} · {p.title}</strong> : <><p className={styles.kicker}>{stateName[p.status]} · {kindName[p.kind]} · {originName[p.origin]} · {stamp(p.createdAt)}</p><h2>{p.title}</h2></>}
    {(!compact || writable) && (compact ? <><p className={styles.preserve}>{draftContent(p)}</p><details className={styles.details}><summary>查看依据和原话</summary>{preview}</details></> : preview)}
    {writable && p.kind === 'event' && event && <p className={styles.muted}>保存到已有事件：{event.title}（追加内容和出处）</p>}
    {writable && staleRevision && <p role="status">这份草稿依据旧版写成。请从当前条目或长期对话重新生成，旧草稿不会覆盖新版。{article && <button type="button" onClick={() => openArticle(article.id)}>查看当前条目</button>}</p>}
    {writable && p.kind === 'article' && article && <details className={styles.details}><summary>{p.operation === 'revise' ? '修订正文' : '补充材料'} · {article.title}（保留旧版）</summary><p className={styles.preserve}>{article.fact}</p></details>}
    <div className={styles.actions}>
      {writable && (!mode && canSave) && <button type="button" className={styles.primary} disabled={busy} onClick={() => void (p.kind === 'event' ? saveEvent(eventDraft(p, data, event), event?.id) : saveArticle(articleDraft(p), article?.id, true))}>{busy ? '正在保存…' : p.kind === 'event' ? eventLabel : articleLabel}</button>}
      {writable && <>
        {p.kind !== 'question' && !staleRevision && <button type="button" disabled={busy} aria-expanded={mode === p.kind} onClick={() => change(mode === p.kind ? undefined : p.kind === 'event' ? 'event' : 'article')}>{mode === p.kind ? '收起编辑' : '编辑后保存'}</button>}
        <button type="button" disabled={busy} onClick={() => change(mode === 'classify' ? undefined : 'classify')}>更改类型</button>
        <button type="button" disabled={busy} onClick={() => { change('correct'); setCorrection(p.correction ?? '') }}>{p.kind === 'question' ? '回应这个判断' : '纠正判断'}</button>
        <button type="button" disabled={busy} onClick={() => void act({ action: 'dismiss' }, '已驳回，未写入正式档案。')}>驳回</button>
      </>}
      {openChat && <button type="button" disabled={busy} onClick={async () => { if (await work(() => api('/focus', body({ id: p.id })))) openChat() }}>{p.kind === 'question' ? '接着聊这个推测' : '回到长期对话核对'}</button>}
      {receipt && compact && <button type="button" onClick={() => (receipt.kind === 'event' ? openEvent : openArticle)(receipt.id)}>查看已保存的档案</button>}
    </div>
    {writable && mode === 'classify' && <div className={styles.segment}><h3>这条内容更适合归到哪里？</h3><div className={styles.actions}>{(['event', 'article', 'question'] as const).map(kind => <button key={kind} type="button" disabled={busy || p.kind === kind} onClick={() => void act({ action: 'classify', kind }, '已更改类型，原话和来源保留。')}>{kindName[kind]}</button>)}</div><p className={styles.muted}>改类型不会写入正式档案，确认草稿后才会保存。</p></div>}
    {writable && mode === 'correct' && <form className={styles.form} onSubmit={e => { e.preventDefault(); void act({ action: 'correct', correction }, '已保存你的纠正。') }}><fieldset disabled={busy}><Field label="哪里不对？应该怎么理解？"><textarea required maxLength={1500} value={correction} onChange={e => setCorrection(e.target.value)} /></Field><div className={styles.actions}><button type="submit" className={styles.primary}>保存纠正</button><button type="button" onClick={() => change()}>取消</button></div></fieldset></form>}
    {writable && mode === 'event' && <div className={styles.segment}><Field label="保存到哪里？"><select disabled={busy} value={target} onChange={e => setTarget(e.target.value)}><option value="">新建事件</option>{data.events.map(e => <option key={e.id} value={e.id}>补充 · {e.title}</option>)}</select></Field>
      <EventForm key={target} initial={eventDraft(p, data, data.events.find(e => e.id === target))} chapters={data.chapters} contexts={data.contexts} suggestedContexts={mentionedDiaryCards(p.evidence, data.contexts)} label={target ? '确认补充到同一个事件' : '确认新建事件'} actions={<button type="button" onClick={() => change()}>取消</button>} onSave={value => saveEvent(value, target || undefined)} />
    </div>}
    {writable && !staleRevision && mode === 'article' && <div className={styles.segment}><Field label="写到哪个条目？"><select disabled={busy || p.operation === 'revise'} value={target} onChange={e => setTarget(e.target.value)}><option value="">新建条目</option>{data.articles.filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>修订 · {a.title}</option>)}</select></Field>
      {existingArticle && existingArticle.id !== article?.id && <details className={styles.details}><summary>查看旧版正文</summary><p className={styles.preserve}>{existingArticle.fact}</p></details>}
      <ArticleForm key={target} data={data} initial={articleDraft(p, existingArticle)} actions={<button type="button" onClick={() => change()}>取消</button>} onSave={value => saveArticle(value, target || undefined)} />
    </div>}
  </article>
}
function ThemeGroupBatch({ group, work, onSaved }: { group: ProposalThemeGroup; work: Work; onSaved: (receipt: Receipt) => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(group.items.map(i => [i.id, true])))
  const [busy, setBusy] = useState(false)
  const pickedIds = group.items.filter(i => checked[i.id] !== false).map(i => i.id)
  async function submit(action: 'accept' | 'dismiss') {
    if (busy || pickedIds.length < 2) return
    setBusy(true)
    try {
      const res = await work(
        () => api<{ id?: string; count: number }>('/proposals/batch-article', body({ ids: pickedIds, target: group.targetArticleId, action })),
        action === 'accept' ? `已合并确认 ${pickedIds.length} 条草稿到百科。` : `已批量驳回 ${pickedIds.length} 条草稿。`,
      )
      if (action === 'accept' && res?.id) onSaved({ id: res.id, kind: 'article' })
    } finally { setBusy(false) }
  }
  return <section className={styles.segment}>
    <strong>{group.targetArticleId ? `补充已有百科《${group.title}》` : `合并新建《${group.title}》`} · {group.items.length} 条同主题草稿</strong>
    <div className={styles.stack}>{group.items.map(item => <label key={item.id} className={styles.compare}>
      <input type="checkbox" disabled={busy} checked={checked[item.id] !== false} onChange={e => setChecked(prev => ({ ...prev, [item.id]: e.target.checked }))} />
      <span> <strong>{item.title}</strong>：{draftContent(item)}</span>
      <small className={styles.muted}>依据：{item.basis} · {item.evidence.length} 条原话</small>
    </label>)}</div>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={busy || pickedIds.length < 2} onClick={() => void submit('accept')}>一次并入选中项（{pickedIds.length} 条）</button>
      <button type="button" disabled={busy || pickedIds.length < 2} onClick={() => void submit('dismiss')}>全部驳回</button>
    </div>
  </section>
}
export default function Inbox({ data, target, open, work, openEvent, openArticle, openChat, openCard }: { data: Data; target?: string; open: (id?: string) => void; work: Work; openEvent: (id: string) => void; openArticle: (id: string) => void; openChat: () => void; openCard: (id: string) => void }) {
  const [filter, setFilter] = useState<'pending' | 'handled'>('pending'), [receipt, setReceipt] = useState<Receipt>()
  const proposals = data.proposals.filter(p => !p.originId?.startsWith('profile:'))
  const list = proposals.filter(p => (p.status === 'pending') === (filter === 'pending')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const groups = filter === 'pending' ? groupArticleProposals(list, data.articles.filter(a => !a.deleted)) : []
  const p = list.find(p => p.id === target) ?? list[0]
  return <Page kicker="编辑台 / 收件箱" title="待核对的材料" hint="草稿没问题就直接确认；需要调整再编辑。多条指向同一百科时可按组一次并入。">
    <div className={styles.actions}><button type="button" aria-pressed={filter === 'pending'} onClick={() => { setFilter('pending'); open() }}>待审核 · {proposals.filter(p => p.status === 'pending').length}</button><button type="button" aria-pressed={filter === 'handled'} onClick={() => { setFilter('handled'); open() }}>已处理</button></div>
    {receipt && <div className={styles.actions}><span role="status">{receipt.kind === 'event' ? '事件已保存' : '百科已保存'}</span><button type="button" onClick={() => (receipt.kind === 'event' ? openEvent : openArticle)(receipt.id)}>查看刚保存的档案</button></div>}
    {groups.length > 0 && <details className={styles.details} open><summary>同主题打包审核 · {groups.length} 组可一次并入</summary>
      <div className={styles.stack}>{groups.map(g => <ThemeGroupBatch key={g.key} group={g} work={work} onSaved={setReceipt} />)}</div>
    </details>}
    <div className={styles.split}><div className={styles.list}>{list.length ? list.map(item => <button type="button" key={item.id} aria-current={p?.id === item.id ? 'true' : undefined} onClick={() => open(item.id)}><small>{kindName[item.kind]} · {item.kind === 'article' ? categoryName(item.category) : originName[item.origin]}</small><strong>{item.title}</strong></button>) : <Empty>这里暂时没有建议。</Empty>}</div>
    {p && <ProposalCard key={p.id} p={p} data={data} work={work} openEvent={openEvent} openArticle={openArticle} openChat={openChat} onSaved={setReceipt} />}</div>
    <ContextInbox data={data} work={work} openCard={openCard} />
  </Page>
}
