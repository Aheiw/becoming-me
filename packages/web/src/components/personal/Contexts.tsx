import { useEffect, useState, type FormEvent } from 'react'
import { indexEventContexts } from '../../../../server/src/personal/contextEvents.js'
import { EventPicker } from './Events.js'
import { aliasDraft, AliasField, personAliases } from './PersonAliases.js'
import { api, body, Empty, EvidenceList, EventLinks, Field, Page, type Data, type LifeContext, type OpenComparison, type Work } from './shared.js'
import SliceCompare from './SliceCompare.js'
import styles from './Personal.module.css'

type Draft = Omit<LifeContext, 'id' | 'updatedAt'>
const names = { person: '人物', environment: '环境' }
const blank = (kind: Draft['kind']): Draft => ({ kind, name: '', role: '', period: '', description: '', impact: '', eventIds: [], links: [] })

function ContextForm({ initial, id, data, save, cancel }: { initial: Draft; id?: string; data: Data; save: (draft: Draft) => Promise<void>; cancel: () => void }) {
  const [draft, set] = useState(initial)
  const [aliasText, setAliasText] = useState(() => aliasDraft(initial.aliases))
  const aliases = personAliases(draft.name, aliasText)
  const [targetId, setTarget] = useState(''), [label, setLabel] = useState('')
  const [pending, setPending] = useState(false)
  const update = <K extends keyof Draft,>(key: K, value: Draft[K]) => set(prev => ({ ...prev, [key]: value }))
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pending || !draft.name.trim() || (draft.kind === 'person' && aliases.invalid)) return
    setPending(true)
    try { await save({ ...draft, aliases: draft.kind === 'person' ? aliases.values : undefined }) } finally { setPending(false) }
  }
  return <form className={`${styles.card} ${styles.form}`} onSubmit={submit}>
    <h2>{id ? '编辑' : '新建'}{names[draft.kind]}卡</h2>
    <Field label={draft.kind === 'person' ? '名字或代称' : '环境名称'}><input required maxLength={160} value={draft.name} onChange={e => update('name', e.target.value)} /></Field>
    {draft.kind === 'person' && <AliasField name={draft.name} value={aliasText} change={setAliasText} disabled={pending} />}
    <div className={styles.twoFields}>
      <Field label={draft.kind === 'person' ? '和我的关系' : '是什么环境'}><input maxLength={200} value={draft.role} placeholder={draft.kind === 'person' ? '如：中学老师、朋友' : '如：家庭、学校、城市、工作文化'} onChange={e => update('role', e.target.value)} /></Field>
      <Field label="关联的人生阶段"><input maxLength={120} value={draft.period} placeholder="如：高中三年" onChange={e => update('period', e.target.value)} /></Field>
    </div>
    <Field label="我记得什么"><textarea maxLength={5000} rows={4} value={draft.description} onChange={e => update('description', e.target.value)} /></Field>
    <Field label="我认为它怎样影响了我"><textarea rows={3} maxLength={4000} value={draft.impact} onChange={e => update('impact', e.target.value)} /></Field>
    <details className={styles.details} open={draft.eventIds.length > 0 || undefined}><summary>关联经历 · {draft.eventIds.length}</summary>
      <EventPicker events={data.events} picked={draft.eventIds} change={ids => update('eventIds', ids)} limit={1000} />
    </details>
    <details className={styles.details} open={draft.links.length > 0 || undefined}><summary>关联其他人物或环境 · {draft.links.length}</summary>
      {draft.links.map((link, i) => <div key={link.id ?? i} className={styles.segment}>
        <strong>{data.contexts.find(c => c.id === link.targetId)?.name}</strong>
        <Field label="关系说明"><input required maxLength={160} value={link.label} onChange={e => update('links', draft.links.map((l, j) => i === j ? { ...l, label: e.target.value } : l))} /></Field>
        <Field label="关系发生的时间"><input maxLength={120} value={link.period ?? ''} onChange={e => update('links', draft.links.map((l, j) => i === j ? { ...l, period: e.target.value } : l))} /></Field>
        <EventPicker events={data.events} picked={link.eventIds ?? []} change={ids => update('links', draft.links.map((l, j) => i === j ? { ...l, eventIds: ids } : l))} />
        <button type="button" onClick={() => update('links', draft.links.filter((_, j) => j !== i))}>移除关联</button>
      </div>)}
      <Field label="连接到"><select value={targetId} onChange={e => setTarget(e.target.value)}><option value="">选择一张卡</option>{data.contexts.filter(c => c.id !== id).map(c => <option key={c.id} value={c.id}>{c.name} · {names[c.kind]}</option>)}</select></Field>
      <Field label="怎么关联"><input value={label} maxLength={160} placeholder="如：一起工作的同事；在这里认识" onChange={e => setLabel(e.target.value)} /></Field>
      <button type="button" disabled={!targetId || !label.trim() || draft.links.length >= 24} onClick={() => { update('links', [...draft.links, { targetId, label: label.trim() }]); setTarget(''); setLabel('') }}>添加这条关联</button>
    </details>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={pending || !draft.name.trim() || (draft.kind === 'person' && aliases.invalid)}>保存档案</button><button type="button" disabled={pending} onClick={cancel}>取消</button></div>
  </form>
}

function RelationshipMap({ center, cards, events, open, openEvent }: { center: LifeContext; cards: LifeContext[]; events: Data['events']; open: (id: string) => void; openEvent: (id: string) => void }) {
  const edges = cards.flatMap(card => [
    ...center.links.filter(link => link.targetId === card.id).map(link => ({ card, link, a: center.name, b: card.name })),
    ...card.links.filter(link => link.targetId === center.id).map(link => ({ card, link, a: card.name, b: center.name })),
  ])
  return <section className={styles.segment}><h3>关系网络 · {edges.length} 条直接关联</h3>
    {edges.length ? <div className={styles.relationshipMap}>
      <strong className={styles.relationshipCenter}>{center.name}</strong>
      <ul className={styles.relationshipEdges}>{edges.map(({ card, link, a, b }, i) => <li key={link.id ?? i}>
        <div className={styles.relationshipLabel}><span>{a} → {b}：{link.label}{link.period ? ' · ' + link.period : ''}</span>
          <EvidenceList evidence={link.evidence ?? []} /><EventLinks ids={link.eventIds ?? []} events={events} open={openEvent} />
        </div>
        <button type="button" onClick={() => open(card.id)}><strong>{card.name}</strong><small>{names[card.kind]}{card.role ? ` · ${card.role}` : ''}</small></button>
      </li>)}</ul>
    </div> : <p className={styles.muted}>还没有关联。在「编辑档案」里连接其他人物或环境。</p>}
  </section>
}

export default function Contexts({ data, target, work, open, openEvent, openArticle, discuss, busy }: { data: Data; target?: string; work: Work; open: (id?: string) => void; openEvent: (id: string) => void; openArticle: (id: string) => void; discuss: OpenComparison; busy: boolean }) {
  const [kind, setKind] = useState<Draft['kind']>('person')
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const current = data.contexts.find(c => c.id === target)
  const eventContexts = indexEventContexts(data.contexts)
  const relatedEvents = current ? data.events.filter(e => eventContexts.get(e.id)?.has(current.id)).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)) : []
  const viaRelationship = current ? relatedEvents.filter(e => !current.eventIds.includes(e.id)).map(e => e.id) : []
  useEffect(() => { setConfirm(false); if (current) { setEditing(false); setKind(current.kind) } }, [target, current?.kind])
  const records = data.contexts.filter(c => c.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const remove = async (e: LifeContext) => {
    if (await work(() => api(`/contexts/${e.id}`, { method: 'DELETE' }), '卡片与关系链接已删除，关联事件不受影响。')) open()
  }
  return <Page kicker="人生书 / 形成我的背景" title="人物与环境" hint="记录谁、什么地方和什么条件影响过你。用真实经历连接这些卡片，不靠 AI 给别人贴标签。" actions={<button className={styles.primary} type="button" onClick={() => { open(); setConfirm(false); setEditing(true) }}>新建{names[kind]}卡</button>}>
    <div className={styles.actions} aria-label="档案类型">{(['person', 'environment'] as const).map(k => <button key={k} type="button" aria-pressed={k === kind} onClick={() => { setKind(k); setEditing(false); open() }}>{names[k]}</button>)}</div>
    <div className={styles.split}>
      <section className={styles.card}><h2>{names[kind]}目录</h2><div className={styles.list}>{records.map(c => <button type="button" key={c.id} onClick={() => { setEditing(false); open(c.id) }} aria-current={c.id === target ? 'true' : undefined}><strong>{c.name}</strong><small>{[c.role, c.period].filter(Boolean).join(' · ') || `${c.eventIds.length} 个相关事件`}</small></button>)}</div>{!records.length && <Empty>还没有{names[kind]}卡。</Empty>}</section>
      {editing ? <ContextForm key={current?.id ?? kind} id={current?.id} initial={current ?? blank(kind)} data={data} cancel={() => setEditing(false)} save={async draft => {
        const saved = await work(() => api<LifeContext>(current ? `/contexts/${current.id}` : '/contexts', body(draft, current ? 'PATCH' : 'POST')), '档案已保存。')
        if (saved) { setEditing(false); open(saved.id) }
      }} /> : current ? <section className={styles.card}>
        <p className={styles.kicker}>{[names[current.kind], current.role, current.period].filter(Boolean).join(' · ')}</p><h2>{current.name}</h2>
        {current.kind === 'person' && !!current.aliases?.length && <p className={styles.muted}>别名：{current.aliases.join('、')}</p>}
        {current.description && <div className={styles.segment}><h3>我记得什么</h3><p className={styles.preserve}>{current.description}</p></div>}
        {current.impact && <div className={styles.segment}><h3>我理解的影响</h3><p className={styles.preserve}>{current.impact}</p></div>}
        <section className={styles.segment}><h3>相关事件 · {relatedEvents.length}</h3>
          {relatedEvents.length === 0 && <p className={styles.muted}>还没有关联。你可以在这里编辑档案，也可以从事件页添加。</p>}
          <EventLinks ids={relatedEvents.filter(e => current.eventIds.includes(e.id)).map(e => e.id)} events={relatedEvents} open={openEvent} />
          {viaRelationship.length > 0 && <><p className={styles.muted}>来自人物或环境关系</p><EventLinks ids={viaRelationship} events={relatedEvents} open={openEvent} /></>}
        </section>
        <EvidenceList evidence={current.evidence ?? []} />
        <RelationshipMap center={current} cards={data.contexts} events={data.events} open={open} openEvent={openEvent} />
        <div className={styles.actions}><button type="button" onClick={() => setEditing(true)}>编辑档案</button>{confirm ? <><button type="button" onClick={() => void remove(current)}>确认删除档案</button><button type="button" onClick={() => setConfirm(false)}>取消</button></> : <button type="button" onClick={() => setConfirm(true)}>删除</button>}</div>
      </section> : <Empty>选一张卡，就能查阅它和哪些经历、人物或环境连在一起。</Empty>}
    </div>
    <details className={styles.details}><summary>跨环境 / 跨时期对比（看看换了环境或阶段后，哪些变了、哪些没变）</summary>
      <SliceCompare data={data} defaultKind="context" discuss={discuss} openEvent={openEvent} openArticle={openArticle} busy={busy} />
    </details>
  </Page>
}
