import { useState, type FormEvent } from 'react'
import { suggestedDiaryEvents } from '../../../../server/src/personal/contextEvents.js'
import { EventPicker } from './Events.js'
import { matchesContextName, nameKey } from '../../../../server/src/personal/contextNames.js'
import { aliasDraft, AliasField, personAliases } from './PersonAliases.js'
import { api, body, Empty, EvidenceList, Field, type ContextSuggestion, type Data, type LifeContext, type Work } from './shared.js'
import styles from './Personal.module.css'

const types = { person: '人物', environment: '环境', relation: '关系' }
const matching = (cards: LifeContext[], subject: Pick<LifeContext, 'kind' | 'name'>) => cards.filter(card => matchesContextName(card, subject))
const uniqueMatchId = (cards: LifeContext[], subject: Pick<LifeContext, 'kind' | 'name'>) => {
  const matches = matching(cards, subject)
  return matches.length === 1 ? matches[0].id : ''
}
function title(item: ContextSuggestion) {
  const d = item.draft
  return d.kind === 'relation' ? `${d.from.name} → ${d.to.name} · ${d.label}` : d.name
}
function Review({ item, data, work, openCard }: { item: ContextSuggestion; data: Data; work: Work; openCard: (id: string) => void }) {
  const d = item.draft, relation = d.kind === 'relation'
  const [target, setTarget] = useState(''), [kind, setKind] = useState<LifeContext['kind']>(d.kind === 'environment' ? 'environment' : 'person')
  const [name, setName] = useState(relation ? '' : d.name), [role, setRole] = useState(relation ? '' : d.role)
  const [aliasText, setAliasText] = useState(aliasDraft())
  const [description, setDescription] = useState(relation ? '' : d.description), [period, setPeriod] = useState(d.period)
  const [from, setFrom] = useState(() => relation ? uniqueMatchId(data.contexts, d.from) : '')
  const [to, setTo] = useState(() => relation ? uniqueMatchId(data.contexts, d.to) : '')
  const [label, setLabel] = useState(relation ? d.label : ''), [eventIds, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState(false)
  const suggestedEvents = suggestedDiaryEvents(item, data.events, data.contexts)
  const route = `/context-suggestions/${encodeURIComponent(item.id)}`
  const targetCard = data.contexts.find(c => c.id === target)
  const possible = !relation ? matching(data.contexts, { kind, name }).filter(card => card.id !== target) : []
  const conflicts = possible.length > 0 && (!targetCard || nameKey(targetCard.name) !== nameKey(name))
  const aliases = personAliases(name, aliasText)
  const changeTarget = (id: string) => {
    const saved = data.contexts.find(c => c.id === id)
    setTarget(id); if (relation) return
    setAliasText(aliasDraft(saved?.aliases))
    setName(saved?.name ?? d.name); setRole(saved?.role || d.role); setPeriod(saved?.period || d.period)
    setDescription(saved?.description ? [saved.description, d.description && !saved.description.includes(d.description) ? d.description : ''].filter(Boolean).join('\n\n') : d.description)
    setEvents(saved?.eventIds ?? [])
  }
  async function submit(e?: FormEvent) {
    e?.preventDefault(); if (busy || !canConfirm) return
    setBusy(true)
    try {
      await work(() => api<{ id: string }>(route, body(relation
        ? { action: 'relation', fromId: from, toId: to, label, period, eventIds }
        : { action: 'card', kind, target: target || undefined, name, aliases: kind === 'person' ? aliases.values : undefined, role, period, description, eventIds })), '已确认并保留日记出处。')
    } finally { setBusy(false) }
  }
  const fromCard = data.contexts.find(c => c.id === from), toCard = data.contexts.find(c => c.id === to)
  const canConfirm = relation ? !!fromCard && !!toCard && from !== to && !!label.trim()
    : !!name.trim() && !conflicts && (kind !== 'person' || !aliases.invalid)
  const describe = (card: LifeContext) => `${card.name}（${types[card.kind]}${card.period ? ` · ${card.period}` : ''}）`
  const choices = data.contexts.map(c => <option key={c.id} value={c.id}>{c.name} · {types[c.kind]}{c.period ? ` · ${c.period}` : ''}</option>)
  return <section className={styles.card}>
    <p className={styles.kicker}>{types[d.kind]}建议 · {item.status === 'pending' ? '待核对' : item.status === 'accepted' ? '已确认' : '已忽略'}</p><h3>{title(item)}</h3>
    <p className={styles.preserve}>{item.basis}</p>
    <EvidenceList evidence={item.evidence} />
    {item.status === 'pending' && !editing && <>
      {relation ? <p className={styles.preserve}>{fromCard && toCard ? `${describe(fromCard)} → ${describe(toCard)}：${label}` : '请先确认关系两端的档案，再核对关联对象。'}</p>
        : <><p className={styles.muted}>{[target ? '补充已有档案' : '新建档案', types[kind], name, role, period].filter(Boolean).join(' · ')}</p>{description && <p className={styles.preserve}>{description}</p>}</>}
      {!relation && conflicts && <p className={styles.muted}>这个名字或别名已用于现有档案，请先选择补充到哪张档案，或改用更明确的代称。</p>}
      {suggestedEvents.length > 0 && <p className={styles.muted}>关联事件可在「编辑后保存」里核对和勾选。</p>}
      <div className={styles.actions}>
        {canConfirm && <button className={styles.primary} type="button" disabled={busy} onClick={() => void submit()}>{busy ? '正在保存…' : `确认${relation ? '关系' : '档案'}`}</button>}
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>{canConfirm ? '编辑后保存' : '核对并编辑'}</button>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); try { await work(() => api(route, body({ action: 'dismiss' })), '已忽略建议。') } finally { setBusy(false) }
        }}>忽略</button>
      </div>
    </>}
    {item.status === 'pending' && editing && <form className={styles.form} onSubmit={submit}>
      {relation ? <>
        <p className={styles.muted}>先确认两端的档案，再确认这条关系。同名或未匹配时请手选；也可以先审核其他建议再回来。</p>
        <div className={styles.twoFields}>
          <Field label={`起点 · 原建议 ${d.from.name}`}><select required value={from} onChange={e => setFrom(e.target.value)}><option value="">选已确认档案</option>{choices}</select></Field>
          <Field label={`终点 · 原建议 ${d.to.name}`}><select required value={to} onChange={e => setTo(e.target.value)}><option value="">选已确认档案</option>{choices}</select></Field>
        </div>
        <Field label="怎么关联"><input required maxLength={160} value={label} onChange={e => setLabel(e.target.value)} /></Field>
      </> : <>
        <Field label="档案类型"><select value={kind} onChange={e => { changeTarget(''); setKind(e.target.value as typeof kind) }}><option value="person">人物</option><option value="environment">环境</option></select></Field>
        <Field label="保存到"><select value={target} onChange={e => changeTarget(e.target.value)}><option value="">新建档案</option>{data.contexts.filter(c => c.kind === kind).map(c => <option key={c.id} value={c.id}>补充 · {c.name}{c.period ? ` · ${c.period}` : ''}</option>)}</select></Field>
        {conflicts && <p className={styles.muted}>使用这个名字或别名的档案：{possible.map(c => c.name).join('、')}。请核对是同一对象，还是改用更明确的代称。</p>}
        <Field label="名字或代称"><input required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></Field>
        {kind === 'person' && <AliasField name={name} value={aliasText} change={setAliasText} disabled={busy} />}
        <Field label="角色或环境类型"><input maxLength={200} value={role} onChange={e => setRole(e.target.value)} /></Field>
        <Field label="档案内容"><textarea rows={4} maxLength={5000} value={description} onChange={e => setDescription(e.target.value)} /></Field>
      </>}
      <Field label="时间或人生阶段"><input maxLength={120} value={period} onChange={e => setPeriod(e.target.value)} /></Field>
      {suggestedEvents.length > 0 && <p className={styles.muted}>有 {suggestedEvents.length} 件已确认的事件引用了同一篇日记并提到相关对象。请核对后自行勾选。</p>}
      <EventPicker events={data.events} picked={eventIds} change={setEvents} suggested={suggestedEvents} limit={relation ? 12 : 1000} />
      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={busy || !canConfirm}>确认{relation ? '关系' : '档案'}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>收起编辑</button>
        {relation && <button type="button" onClick={() => openCard(from || to)}>打开人物与环境</button>}
      </div>
    </form>}
  </section>
}
export default function ContextInbox({ data, work, openCard }: { data: Data; work: Work; openCard: (id: string) => void }) {
  const [handled, setHandled] = useState(false), [id, select] = useState('')
  const all = data.contextSuggestions ?? []
  const items = all.filter(p => (p.status !== 'pending') === handled)
  const current = items.find(p => p.id === id) ?? items[0]
  return <section className={styles.segment}>
    <h2>人物、环境与关系审核</h2>
    <div className={styles.actions}><button type="button" aria-pressed={!handled} onClick={() => { setHandled(false); select('') }}>待核对 · {all.filter(p => p.status === 'pending').length}</button><button type="button" aria-pressed={handled} onClick={() => { setHandled(true); select('') }}>已处理</button></div>
    <div className={styles.split}><div className={styles.list}>{items.length ? items.map(p => <button type="button" key={p.id} aria-current={p.id === current?.id ? 'true' : undefined} onClick={() => select(p.id)}><small>{types[p.draft.kind]}</small><strong>{title(p)}</strong></button>) : <Empty>这里暂时没有建议。</Empty>}</div>
    {current ? <Review key={current.id} item={current} data={data} work={work} openCard={openCard} /> : <Empty>这里暂时没有需要查看的档案建议。</Empty>}</div>
  </section>
}
