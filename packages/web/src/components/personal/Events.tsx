import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api, body, day, Field, Empty, Page, eventTime, type Chapter, type Data, type EventImportance, type LifeEvent, type OpenComparison, type Work } from './shared.js'
import { eventImportance, hasTopics, importanceLabel, turningEvents } from '../../../../server/src/personal/reading.js'
import Perspectives from './Perspectives.js'
import styles from './Personal.module.css'

export type EventFields = { title: string; date: string; dateNote: string; cause: string; facts: string; outcome: string; outlook: string; prediction: string; impact: string; analysis: string; chapterId?: string; topics: string[]; importance: EventImportance | null }
export const eventFields = (e?: Partial<EventFields>): EventFields => ({ title: e?.title ?? '', date: e?.date ?? '', dateNote: e?.dateNote ?? '', cause: e?.cause ?? '', facts: e?.facts ?? '', outcome: e?.outcome ?? '', outlook: e?.outlook ?? '', prediction: e?.prediction ?? '', impact: e?.impact ?? '', analysis: e?.analysis ?? '', chapterId: e?.chapterId || undefined, topics: e?.topics ?? [], importance: e?.importance ?? null })
export function EventForm({ initial, chapters, onSave, actions, label = '保存事件' }: { initial: EventFields; chapters: Chapter[]; onSave: (value: EventFields) => Promise<unknown>; actions?: ReactNode; label?: string }) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [topicText, setTopicText] = useState(initial.topics.join('、'))
  const topics = [...new Set(topicText.split(/[、，,；;\n]/u).map(t => t.trim()).filter(Boolean))]
  const topicError = topics.length > 12 || topics.some(t => t.length > 24)
  function edit(key: keyof EventFields, content: string) { setValue(prev => ({ ...prev, [key]: content || (key === 'chapterId' ? undefined : '') })) }
  async function submit(e: FormEvent) { e.preventDefault(); if (topicError) return; setBusy(true); try { await onSave({ ...value, topics }) } finally { setBusy(false) } }
  return <form className={styles.form} onSubmit={submit}><fieldset disabled={busy}>
    {actions}
    <Field label="事件标题"><input required maxLength={600} value={value.title} onChange={e => edit('title', e.target.value)} /></Field>
    <div className={styles.grid}><Field label="发生时间" hint="支持 2020、2020-06 或 2020-06-25；未知就留空。"><input value={value.date} placeholder="年 / 年月 / 年月日" pattern="\d{4}(-\d{2}(-\d{2})?)?" onChange={e => edit('date', e.target.value)} /></Field>
    <Field label="时间备注"><input value={value.dateNote} maxLength={120} placeholder="例如：毕业后不久" onChange={e => edit('dateNote', e.target.value)} /></Field></div>
    <Field label="人生章节"><select value={value.chapterId ?? ''} onChange={e => edit('chapterId', e.target.value)}><option value="">未分章</option>{chapters.map(ch => <option key={ch.id} value={ch.id}>{ch.title}</option>)}</select></Field>
    <div className={styles.grid}><Field label="事件标记"><select value={value.importance ?? ''} onChange={e => setValue(v => ({ ...v, importance: (e.target.value || null) as EventImportance | null }))}><option value="">未另行标记（沿用已关联的观点转折）</option>{Object.entries(importanceLabel).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></Field>
    <Field label="事件主题" hint={topicError ? '最多 12 个主题，每个不超过 24 字。' : '同一件事可以属于多个主题，用顿号或逗号分隔。'}><input aria-invalid={topicError} maxLength={340} placeholder="例如：职业选择、关系、生活方式" value={topicText} onChange={e => setTopicText(e.target.value)} /></Field></div>
    <Field label="起因" hint="已知的背景或触发点，不清楚可留空。"><textarea rows={2} maxLength={3000} value={value.cause} onChange={e => edit('cause', e.target.value)} /></Field>
    <Field label="事情经过（必填）"><textarea required rows={4} maxLength={5000} value={value.facts} onChange={e => edit('facts', e.target.value)} /></Field>
    <Field label="实际结果" hint="已知结果；没发生或不知道就留空，不填预期。"><textarea rows={3} maxLength={4000} value={value.outcome} onChange={e => edit('outcome', e.target.value)} /></Field>
    {([
      ['outlook', '当时的想法和选择理由', 4000], ['prediction', '当时的预期', 3000], ['impact', '这件事对我的影响', 4000], ['analysis', '可能体现什么（允许不确定）', 3000],
    ] as const).map(([key, title, max]) => <Field key={key} label={title}><textarea rows={2} maxLength={max} value={value[key]} onChange={e => edit(key, e.target.value)} /></Field>)}
    <button className={styles.primary} type="submit" disabled={topicError}>{busy ? '正在保存…' : label}</button>
  </fieldset></form>
}

export function EventPicker({ events, picked, change }: { events: LifeEvent[]; picked: string[]; change: (ids: string[]) => void }) {
  return <details className={styles.details}><summary>选择参考事件 · {picked.length} 项</summary><div className={styles.picker}>{events.length ? events.map(e => <label key={e.id}><input type="checkbox" checked={picked.includes(e.id)} disabled={picked.length >= 12 && !picked.includes(e.id)} onChange={ev => change(ev.target.checked ? [...picked, e.id] : picked.filter(id => id !== e.id))} />{eventTime(e)} · {e.title}</label>) : <p>还没有事件。</p>}</div></details>
}
function ChapterForm({ chapter, work, done }: { chapter?: Chapter; work: Work; done: () => void }) {
  const [title, setTitle] = useState(chapter?.title ?? ''), [introduction, setIntro] = useState(chapter?.introduction ?? ''), [order, setOrder] = useState(chapter?.order ?? 0)
  return <form className={styles.form} onSubmit={async e => { e.preventDefault(); if (await work(() => api(`/chapters${chapter ? `/${chapter.id}` : ''}`, body({ title, introduction, order }, chapter ? 'PATCH' : 'POST')), '人生章节已保存。')) done() }}>
    <Field label="章节名"><input required maxLength={180} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：第一次独立生活" /></Field>
    <Field label="章节介绍"><textarea maxLength={3500} value={introduction} onChange={e => setIntro(e.target.value)} /></Field>
    {chapter && <Field label="章节顺序（从 0 开始）"><input type="number" min={0} required value={order} onChange={e => setOrder(e.target.valueAsNumber)} /></Field>}
    <div className={styles.actions}><button className={styles.primary} type="submit">保存章节</button><button type="button" onClick={done}>取消</button></div>
  </form>
}
function FollowupForm({ id, work, done }: { id: string; work: Work; done: () => void }) {
  const [date, setDate] = useState(day()), [outcome, setOutcome] = useState(''), [reflection, setReflection] = useState('')
  return <form className={styles.form} onSubmit={async e => { e.preventDefault(); if (await work(() => api(`/events/${id}/followups`, body({ date, outcome, reflection })), '回访已新增，原来的预期保留不变。')) done() }}>
    <Field label="回访日期"><input required type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
    <Field label="后来实际发生了什么"><textarea required maxLength={5000} value={outcome} onChange={e => setOutcome(e.target.value)} /></Field>
    <Field label="现在怎么看"><textarea maxLength={4000} value={reflection} onChange={e => setReflection(e.target.value)} /></Field>
    <div className={styles.actions}><button className={styles.primary} type="submit">保存回访</button><button type="button" onClick={done}>取消</button></div>
  </form>
}

export default function Events({ data, work, target, open, openArticle, openInbox, busy, discuss }: { discuss: OpenComparison; data: Data; work: Work; target?: string; open: (id?: string) => void; openArticle: (id: string) => void; openInbox: () => void; busy: boolean }) {
  const [mode, setMode] = useState<'time' | 'chapter'>('time'), [editor, setEditor] = useState(''), [chapterEditor, setChapterEditor] = useState('')
  const [picked, setPicked] = useState<string[]>([]), [result, setResult] = useState<number>()
  const events = [...data.events].sort((a, b) => Number(Boolean(b.date)) - Number(Boolean(a.date)) || b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt))
  const [selectedTopics, setTopics] = useState<string[]>([])
  const topics = [...new Set(events.flatMap(e => e.topics ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const activeTopics = selectedTopics.filter(t => topics.includes(t))
  const visibleEvents = events.filter(e => hasTopics(e, activeTopics))
  const turns = useMemo(() => turningEvents(data.turningPoints), [data.turningPoints])
  useEffect(() => { if (!target) return; setEditor('') }, [target])
  const chapters = [...data.chapters].sort((a, b) => a.order - b.order)
  const event = events.find(e => e.id === target)
  const related = data.articles.filter(a => !a.deleted && a.eventIds.includes(target ?? ''))
  const select = (id: string) => { setEditor(''); open(id) }
  const rows = (list: LifeEvent[]) => <ol className={styles.timeline}>{list.map(e => <li key={e.id}><button type="button" aria-current={e.id === target ? 'true' : undefined} onClick={() => select(e.id)}><time>{eventTime(e)}{e.date && e.dateNote && ` · ${e.date}`}</time><strong>{e.title}</strong>{(eventImportance(e, turns) !== 'regular' || !!e.topics?.length) && <small>{[eventImportance(e, turns) !== 'regular' && importanceLabel[eventImportance(e, turns)], ...e.topics ?? []].filter(Boolean).join(' · ')}</small>}</button></li>)}</ol>
  return <Page kicker="人生书 / 大事记" title="事件簿" hint="按时间读自己的经历，也可以把它们编进人生章节。后来想起新的结果，就加一条回访。" actions={<>
    <button className={styles.primary} type="button" onClick={() => { open(); setEditor('new') }}>记一个事件</button>
    <button type="button" onClick={() => { setMode('chapter'); setChapterEditor('new') }}>新建人生章节</button></>}>
    <div className={styles.actions}><button type="button" aria-pressed={mode === 'time'} onClick={() => setMode('time')}>按时间</button><button type="button" aria-pressed={mode === 'chapter'} onClick={() => setMode('chapter')}>按章节</button></div>
    {!!topics.length && <div className={styles.card}><div className={styles.bookHeading}><h3>按主题筛选</h3><small>符合 {visibleEvents.length} / {events.length} 件 · 同时包含所选主题</small></div><div className={styles.actions}><button type="button" aria-pressed={!activeTopics.length} onClick={() => setTopics([])}>全部主题</button>{topics.map(t => <button key={t} type="button" aria-pressed={activeTopics.includes(t)} onClick={() => setTopics(activeTopics.includes(t) ? activeTopics.filter(v => v !== t) : [...activeTopics, t])}>{t}</button>)}</div></div>}
    {chapterEditor && <div className={styles.card}><ChapterForm key={chapterEditor} chapter={chapters.find(ch => ch.id === chapterEditor)} work={work} done={() => setChapterEditor('')} /></div>}
    <div className={styles.split}>
      <div className={styles.stack}>
        {activeTopics.length && !visibleEvents.length ? <Empty>没有同时匹配这些主题的事件，可以取消一个主题试试。</Empty> : mode === 'time' ? (visibleEvents.length ? rows(visibleEvents) : <Empty>还没有事件。可以自己写，也可以在收件箱里把日记或聊天建议整理成事件。</Empty>) : <>
          {chapters.filter(ch => !activeTopics.length || visibleEvents.some(e => e.chapterId === ch.id)).map(ch => <section key={ch.id} className={styles.card}><div className={styles.actions}><h3>{ch.title}</h3><button type="button" onClick={() => setChapterEditor(ch.id)}>编辑章节</button></div>{ch.introduction && <p className={styles.preserve}>{ch.introduction}</p>}{rows(visibleEvents.filter(e => e.chapterId === ch.id))}</section>)}
          {(!activeTopics.length || visibleEvents.some(e => !e.chapterId)) && <section className={styles.card}><h3>未分章</h3>{rows(visibleEvents.filter(e => !e.chapterId))}</section>}
        </>}
      </div>
      <div className={styles.stack}>
        {editor === 'new' || (event && editor === `edit-${event.id}`) ? <div className={styles.card}>
          <h2>{editor === 'new' ? '新事件' : '编辑事件'}</h2>
          <EventForm key={editor} chapters={chapters} initial={eventFields(editor === 'new' ? undefined : event)} actions={<button type="button" onClick={() => setEditor('')}>取消编辑</button>} onSave={async value => {
            const edit = editor !== 'new' && event
            const saved = await work(() => api<LifeEvent>(`/events${edit ? `/${edit.id}` : ''}`, body(value, edit ? 'PATCH' : 'POST')), '事件已保存。')
            if (saved) select(saved.id)
          }} />
        </div> : event ? <article className={styles.card} key={event.id}>
          <p className={styles.kicker}>{eventTime(event)}{event.date && event.dateNote && ` · ${event.date}`} · {chapters.find(ch => ch.id === event.chapterId)?.title ?? '未分章'}</p><h2>{event.title}</h2><p className={styles.muted}>{[importanceLabel[eventImportance(event, turns)], ...event.topics ?? []].join(' · ')}</p>
          <div className={styles.actions}><button type="button" onClick={() => setEditor(`edit-${event.id}`)}>编辑</button><button type="button" onClick={() => setEditor(`follow-${event.id}`)}>加一条回访</button><button type="button" disabled={busy} onClick={async () => {
            const r = await work(() => api<{ count: number }>('/review', body({ eventIds: [event.id], eventOnly: true })), '事件分析已完成，解释仍待你核对。')
            if (r) setResult(r.count)
          }}>请 AI 分析这件事</button></div>
          {[['起因', event.cause], ['事情经过', event.facts], ['实际结果', event.outcome], ['当时的想法和理由', event.outlook], ['当时的预期', event.prediction], ['对我的影响', event.impact], ['解释或假设（不是事实）', event.analysis]].map(([name, value]) => value && <div key={name} className={styles.segment}><h3>{name}</h3><p className={styles.preserve}>{value}</p></div>)}
          {event.followups?.map(f => <div key={f.id} className={styles.segment}><h3>后来 · {f.date}</h3><p className={styles.preserve}>{f.outcome}</p>{f.reflection && <p className={styles.preserve}><strong>事后回看：</strong>{f.reflection}</p>}</div>)}
          {editor === `follow-${event.id}` && <FollowupForm id={event.id} work={work} done={() => setEditor('')} />}
          <Perspectives fixedEvent={event} events={[]} articles={related} openArticle={openArticle} discuss={discuss} busy={busy} />
        </article> : <Empty>选中一个事件，查看它的经过、当时的预期和后来的影响。</Empty>}
        <section className={styles.card}><h3>跨事件复盘</h3><p className={styles.muted}>挑出值得比较的经历。AI 会查找相关旧资料，提出可能的解释和反例，结果进收件箱，不直接写入百科。</p><EventPicker events={events} picked={picked} change={setPicked} />
          <div className={styles.actions}><button type="button" disabled={picked.length < 2 || busy} onClick={async () => { const r = await work(() => api<{ count: number }>('/review', body({ eventIds: picked })), '复盘已完成。'); if (r) setResult(r.count) }}>分析所选事件</button>{result !== undefined && <button type="button" onClick={openInbox}>查看收件箱（新增 {result} 条）</button>}</div>
        </section>
      </div>
    </div>
  </Page>
}
