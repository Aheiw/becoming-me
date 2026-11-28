import { useEffect, useState, type ReactNode } from 'react'
import { articleChapters, chapterFor, type ArticleChapterId } from '../../../../server/src/personal/articleTopics.js'
import ArticleMerge from './ArticleMerge.js'
import type { Revision } from '../../../../server/src/personal/types.js'
import { api, body, categories, categoryName, day, Empty, EvidenceList, EventLinks, Field, Page, stamp, type Article, type Data, type OpenComparison, type Work } from './shared.js'
import Perspectives from './Perspectives.js'
import { EventPicker } from './Events.js'
import styles from './Personal.module.css'

export type ArticleFields = Pick<Article, 'title' | 'category' | 'chapter' | 'fact' | 'limits' | 'eventIds'> & { reason: string; version?: string }
export function ArticleForm({ initial, data, onSave, actions }: { initial: ArticleFields; data: Data; onSave: (value: ArticleFields) => Promise<unknown>; actions?: ReactNode }) {
  const [v, set] = useState(initial), [saving, setSaving] = useState(false)
  const change = <K extends keyof ArticleFields>(key: K, value: ArticleFields[K]) => set(prev => ({ ...prev, [key]: value }))
  return <form className={styles.form} onSubmit={async e => { e.preventDefault(); setSaving(true); try { await onSave(v) } finally { setSaving(false) } }}><fieldset disabled={saving}>
    {actions}<Field label="条目标题"><input required maxLength={600} value={v.title} onChange={e => change('title', e.target.value)} /></Field>
    <Field label="所属章节"><select value={v.chapter ?? ''} onChange={e => change('chapter', (e.target.value || undefined) as ArticleChapterId | undefined)}><option value="">按分类自动归入 · {chapterFor({ category: v.category }).name}</option>{articleChapters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field label="主题分类"><select value={v.category} onChange={e => change('category', e.target.value)}>{categories.map(c => <option key={c} value={c}>{categoryName(c)}</option>)}</select></Field>
    <Field label="百科正文"><textarea rows={6} required maxLength={5000} value={v.fact} onChange={e => change('fact', e.target.value)} /></Field>
    <Field label="适用条件、反例与保留疑问"><textarea rows={3} maxLength={5000} value={v.limits ?? ''} onChange={e => change('limits', e.target.value)} /></Field>
    <Field label="为什么这样写或修改"><input maxLength={500} value={v.reason} onChange={e => change('reason', e.target.value)} /></Field>
    <EventPicker limit={1000} events={data.events} picked={v.eventIds} change={ids => change('eventIds', ids)} />
    <button className={styles.primary} type="submit">{saving ? '正在保存…' : '确认并保存版本'}</button>
  </fieldset></form>
}
const revisionName = { baseline: '原有版本', create: '创建', edit: '修订', delete: '移入回收站', restore: '恢复旧版' }
function History({ id, updatedAt, work, openEvent, data }: { id: string; updatedAt: string; work: Work; openEvent: (id: string) => void; data: Data }) {
  const [versions, setVersions] = useState<Revision[]>([]), [selected, setSelected] = useState(0), [error, setError] = useState('')
  useEffect(() => {
    const c = new AbortController()
    setError(''); api<{ revisions: Revision[] }>(`/articles/${id}/history`, { signal: c.signal }).then(r => { setVersions(r.revisions); setSelected(r.revisions.length - 1) }).catch(e => { if (!c.signal.aborted) setError(e.message) })
    return () => c.abort()
  }, [id, updatedAt])
  const current = versions[selected], previous = versions[selected - 1]
  const pane = (r: Revision, title: string) => <div className={styles.compare}><p className={styles.kicker}>{title} · {revisionName[r.action]} · {stamp(r.at)}</p><p><strong>{r.title}</strong> · {categoryName(r.category)}</p><p>{r.reason}</p><p className={styles.preserve}>{r.fact}</p>{r.limits && <p className={styles.preserve}><strong>适用条件与反例：</strong>{r.limits}</p>}<EventLinks ids={r.eventIds} open={openEvent} events={data.events} /><EvidenceList evidence={r.evidence} /></div>
  return <section className={styles.segment}><h3>版本历史</h3>{error ? <p role="alert">{error}</p> : !current ? <p>正在读取版本…</p> : <>
    <Field label="查看版本"><select value={selected} onChange={e => setSelected(Number(e.target.value))}>{versions.map((v, i) => <option key={i} value={i}>第 {i + 1} 版 · {revisionName[v.action]} · {stamp(v.at)}</option>)}</select></Field>
    <div className={styles.grid}>{previous && pane(previous, '修改前')}{pane(current, previous ? '修改后' : '初始版本')}</div>
    {previous && <p className={styles.muted}>变更：{[previous.title !== current.title && '标题', (previous.category !== current.category || previous.chapter !== current.chapter) && '主题', previous.limits !== current.limits && '适用条件与反例', previous.fact !== current.fact && '正文', previous.eventIds.join() !== current.eventIds.join() && '关联事件', JSON.stringify(previous.evidence) !== JSON.stringify(current.evidence) && '原话来源'].filter(Boolean).join('、') || revisionName[current.action]}</p>}
    {current.action !== 'delete' && selected < versions.length - 1 && <button type="button" onClick={() => { if (confirm('恢复所选内容，保存为一个新版本？旧版本不会删除。')) void work(() => api(`/articles/${id}/restore`, body({ index: selected })), '已恢复成新版本，历史仍保留。') }}>恢复这一版</button>}
  </>}</section>
}
function TurningForm({ id, work, data, close }: { id: string; work: Work; data: Data; close: () => void }) {
  const [v, set] = useState({ date: day(), before: '', after: '', why: '', eventId: '' })
  return <form className={styles.form} onSubmit={async e => { e.preventDefault(); if (await work(() => api(`/articles/${id}/turning-points`, body({ ...v, eventId: v.eventId || undefined })), '已记下观点变化。')) close() }}>
    <Field label="变化发生的大约时间"><input value={v.date} pattern="\d{4}(-\d{2}(-\d{2})?)?" onChange={e => set({ ...v, date: e.target.value })} /></Field>
    {([['before', '以前我是怎么看的', 2500], ['after', '后来怎么看', 2500], ['why', '什么让我改变', 3000]] as const).map(([key, label, max]) => <Field key={key} label={label}><textarea required maxLength={max} value={v[key]} onChange={e => set({ ...v, [key]: e.target.value })} /></Field>)}
    <Field label="相关转折事件"><select value={v.eventId} onChange={e => set({ ...v, eventId: e.target.value })}><option value="">暂不关联</option>{data.events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></Field>
    <div className={styles.actions}><button className={styles.primary} type="submit">保存观点变化</button><button type="button" onClick={close}>取消</button></div>
  </form>
}
export default function Articles({ data, target, open, openEvent, work, busy, openInbox, discuss, discussQuestion }: { discuss: OpenComparison; discussQuestion: (id: string) => void; data: Data; target?: string; open: (id?: string) => void; openEvent: (id: string) => void; work: Work; busy: boolean; openInbox: () => void }) {
  const [filter, setFilter] = useState(''), [recycle, setRecycle] = useState(false), [editor, setEditor] = useState(''), [reviewIds, setReviewIds] = useState<string[]>([]), [result, setResult] = useState<number>()
  const a = data.articles.find(a => a.id === target)
  useEffect(() => { if (!target) return; setEditor(''); setReviewIds(data.articles.find(item => item.id === target)?.eventIds ?? []); setResult(undefined) }, [target])
  const choose = (id?: string) => { setEditor(''); setResult(undefined); setReviewIds(data.articles.find(a => a.id === id)?.eventIds ?? []); open(id) }
  const list = data.articles.filter(a => a.deleted === recycle && (!filter || chapterFor(a).id === filter))
  const questions = data.proposals.filter(p => p.kind === 'question' && !p.originId?.startsWith('profile:') && (p.status === 'pending' || p.status === 'corrected'))
  const linked = a && !a.deleted ? questions.filter(p => p.articleId === a.id) : []
  const unlinked = questions.filter(p => (!p.articleId || !data.articles.some(a => a.id === p.articleId && !a.deleted)) && (!filter || chapterFor(p).id === filter))
  const questionList = (items: typeof questions) => items.map(p => <article key={p.id} className={styles.compare}>
    <p className={styles.kicker}>{p.correction ? '已保留你的纠正' : 'AI 推测 · 尚未写入百科'}</p><h4>{p.title}</h4>
    <p className={styles.preserve}>{p.content}</p>{p.basis && <p className={styles.preserve}><strong>为什么这样猜：</strong>{p.basis}</p>}
    {p.counterpoint && <p className={styles.preserve}><strong>反例或其他解释：</strong>{p.counterpoint}</p>}
    {p.correction && <p className={styles.preserve}><strong>你的纠正：</strong>{p.correction}</p>}
    <EvidenceList evidence={p.evidence} /><EventLinks ids={p.eventIds} events={data.events} open={openEvent} />
    <button type="button" disabled={busy} onClick={() => discussQuestion(p.id)}>接着聊这个推测</button>
  </article>)
  const points = a && [...data.turningPoints[a.id] ?? []].sort((a, b) => a.date.localeCompare(b.date))
  return <Page kicker="人生书 / 主题索引" title="我的百科" hint="按主题查阅你确认过的认识。原话、关联事件和历次修改都可以回看。" actions={<><button type="button" onClick={() => { choose(); setEditor('merge') }}>归并旧条目</button><button className={styles.primary} type="button" onClick={() => { choose(); setEditor('new') }}>写一个条目</button></>}>
    {editor === 'merge' && <ArticleMerge data={data} initialChapter={filter || 'decisions'} work={work} busy={busy} close={() => setEditor('')} open={id => { setRecycle(false); setFilter(''); choose(id) }} openEvent={openEvent} />}
    <div className={styles.actions}><select aria-label="筛选章节" value={filter} onChange={e => { setFilter(e.target.value); choose() }}><option value="">所有章节</option>{articleChapters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button type="button" aria-pressed={recycle} onClick={() => { setRecycle(!recycle); choose() }}>{recycle ? '返回正式百科' : '回收站'}</button></div>
    <div className={styles.split}><aside className={styles.stack}>{list.length ? articleChapters.map(c => {
      const items = list.filter(a => chapterFor(a).id === c.id)
      return items.length > 0 && <div className={styles.card} key={c.id}><h3>{c.name}</h3><div className={styles.list}>{items.map(a => <button type="button" key={a.id} aria-current={target === a.id ? 'true' : undefined} onClick={() => choose(a.id)}>{a.title}</button>)}</div></div>
    }) : <Empty>{recycle ? '回收站为空。' : '这个范围还没有条目。可以自己写，也可以从收件箱确认。'}</Empty>}</aside>
    <div className={styles.stack}>{editor === 'new' || (a && editor === `edit-${a.id}`) ? <div className={styles.card}><h2>{editor === 'new' ? '新条目' : '修订条目'}</h2><ArticleForm key={editor} initial={editor !== 'new' && a ? { ...a, reason: '' } : { title: '', category: articleChapters.find(c => c.id === filter)?.categories[0] ?? 'patterns', chapter: (filter || undefined) as ArticleChapterId | undefined, fact: '', eventIds: [], reason: '' }} data={data} actions={<button type="button" onClick={() => setEditor('')}>取消编辑</button>} onSave={async value => {
      const current = editor !== 'new' && a
      const saved = await work(() => api<{ id?: string }>(`/articles${current ? `/${current.id}` : ''}`, body(value, current ? 'PATCH' : 'POST')), '新版本已保存。')
      if (saved) { setRecycle(false); setFilter(''); choose(current ? current.id : saved.id) }
    }} /></div> : a ? <article className={styles.card} key={a.id}><p className={styles.kicker}>{chapterFor(a).name}{a.deleted && ' · 回收站'}</p><h2>{a.title}</h2>
      <h3>已确认的认识</h3><p className={styles.preserve}>{a.fact}</p>{a.limits && <section className={styles.segment}><h3>适用条件、反例与保留疑问</h3><p className={styles.preserve}>{a.limits}</p></section>}<EvidenceList evidence={a.evidence} /><EventLinks ids={a.eventIds} events={data.events} open={openEvent} />
      <div className={styles.actions}>
        {!a.deleted && <><button type="button" onClick={() => setEditor(`edit-${a.id}`)}>编辑</button><button type="button" onClick={() => setEditor(`point-${a.id}`)}>记一次观点变化</button><button type="button" onClick={async () => { if (confirm('移入回收站？仍可查看并恢复旧版。') && await work(() => api(`/articles/${a.id}`, { method: 'DELETE' }), '已移入回收站。')) setRecycle(true) }}>移入回收站</button></>}
        <button type="button" onClick={() => setEditor(editor === `history-${a.id}` ? '' : `history-${a.id}`)}>修订历史与恢复</button>
      </div>
      {linked.length > 0 && <section className={styles.segment}><h3>仍在核对的推测与纠正</h3>{questionList(linked)}</section>}
      {!a.deleted && <Perspectives fixedArticle={a} events={a.eventIds.flatMap(id => data.events.filter(e => e.id === id))} articles={[]} openEvent={openEvent} discuss={discuss} busy={busy} />}
      {editor === `history-${a.id}` && <History id={a.id} updatedAt={a.updatedAt} work={work} data={data} openEvent={openEvent} />}
      {points && points.length > 0 && <section className={styles.segment}><h3>观点演变史</h3>{points.map(p => <div className={styles.compare} key={p.id}><p className={styles.kicker}>{p.date || '日期未知'}</p><p className={styles.preserve}><strong>原来：</strong>{p.before}</p><p className={styles.preserve}><strong>后来：</strong>{p.after}</p><p className={styles.preserve}><strong>为什么变了：</strong>{p.why}</p><EventLinks ids={p.eventId ? [p.eventId] : []} events={data.events} open={openEvent} /></div>)}</section>}
      {editor === `point-${a.id}` && <TurningForm id={a.id} work={work} data={data} close={() => setEditor('')} />}
      {!a.deleted && <section className={styles.segment}><h3>请 AI 提出修订</h3><p className={styles.muted}>选择参考事件；AI 结合相关旧资料提出草稿，你确认前不会改动条目。</p><EventPicker key={a.id} events={data.events} picked={reviewIds} change={setReviewIds} />
        <div className={styles.actions}><button type="button" disabled={busy || !reviewIds.length} onClick={async () => { const r = await work(() => api<{ count: number }>('/review', body({ articleId: a.id, eventIds: reviewIds })), 'AI 修订分析已完成。'); if (r) setResult(r.count) }}>生成修订草稿</button>{result !== undefined && <button type="button" onClick={openInbox}>查看收件箱（新增 {result} 条）</button>}</div></section>}
      </article> : <Empty>选一个主题，查看已有认识和依据。</Empty>}</div>
    </div>
    {!recycle && unlinked.length > 0 && <section className={styles.card}><h2>尚未归入条目的推测</h2><p className={styles.muted}>可从原话和反例聊起。不必为了记录一次猜测而新建条目。</p><div className={styles.grid}>{questionList(unlinked)}</div></section>}
  </Page>
}
