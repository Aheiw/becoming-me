import { useState } from 'react'
import { articleChapters, chapterFor } from '../../../../server/src/personal/articleTopics.js'
import type { Article, Revision } from '../../../../server/src/personal/types.js'
import { api, body, EvidenceList, EventLinks, Field, type Data, type Work } from './shared.js'
import styles from './Personal.module.css'

type Preview = { ids: string[]; mark: string; sources: { id: string; last: Revision; versions: number }[]; article: Article }
type MergeGroup = { ids: string[]; suggestedTitle: string; reason: string; caution: string }

export default function ArticleMerge({ data, initialChapter, work, busy, close, open, openEvent }: {
  data: Data; initialChapter: string; work: Work; busy: boolean; close: () => void; open: (id: string) => void; openEvent: (id: string) => void
}) {
  const [chapter, setChapter] = useState(initialChapter || 'decisions'), [selected, select] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<MergeGroup[]>([]), [searched, setSearched] = useState(false)
  const [preview, setPreview] = useState<Preview>(), [title, setTitle] = useState(''), [fact, setFact] = useState(''), [editing, setEditing] = useState(false)
  const candidates = data.articles.filter(a => !a.deleted && chapterFor(a).id === chapter)
  const sourceList = selected.flatMap(id => candidates.filter(a => a.id === id))
  const byId = new Map(candidates.map(a => [a.id, a]))

  async function openPreview(ids: string[]) {
    const draft = await work(() => api<Preview>('/articles/merge-preview', body({ ids })))
    if (draft) { setPreview(draft); setTitle(draft.article.title); setFact(draft.article.fact); setEditing(false) }
  }

  return <section className={styles.card}><h2>归并旧条目</h2>
    <p className={styles.muted}>只挑回答同一个问题的条目，不是把整章并成一条。AI 会读取所选百科正文生成草稿；预览前后都不会改档案，直到你点确认。</p>
    <div className={styles.actions}><button type="button" onClick={close}>关闭归并</button></div>
    {!preview ? <>
      <Field label="所在章节"><select disabled={busy} value={chapter} onChange={e => { setChapter(e.target.value); select([]); setSuggestions([]); setSearched(false) }}>{articleChapters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <div className={styles.picker}>{candidates.map(a => <label key={a.id}><input type="checkbox" disabled={busy || !selected.includes(a.id) && selected.length >= 8} checked={selected.includes(a.id)} onChange={e => select(e.target.checked ? [...selected, a.id] : selected.filter(id => id !== a.id))} /> {a.title}</label>)}</div>
      {candidates.length < 2 && <p>本章不满两条，无需归并。</p>}
      {sourceList.length > 1 && <Field label="保留为主条目"><select value={selected[0]} disabled={busy} onChange={e => select([e.target.value, ...selected.filter(id => id !== e.target.value)])}>{sourceList.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select></Field>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy || sourceList.length < 2} onClick={() => void openPreview(sourceList.map(a => a.id))}>生成归并预览</button>
        {candidates.length >= 2 && <button type="button" disabled={busy} onClick={async () => {
          const res = await work(() => api<{ groups: MergeGroup[] }>('/articles/merge-suggestions', body({ chapter })))
          if (res) { setSuggestions(res.groups); setSearched(true) }
        }}>AI 查找可能重复的主题</button>}
      </div>
      {searched && !suggestions.length && <p className={styles.muted}>AI 未在本章发现确实属于同一问题的重复条目；如有需要仍可手动勾选归并。</p>}
      {suggestions.map((group, idx) => <section className={styles.segment} key={`${group.ids.join(',')}-${idx}`}>
        <strong>{group.suggestedTitle || '建议归并的候选组'}</strong>
        <p className={styles.muted}>涉及条目：{group.ids.map(id => byId.get(id)?.title ?? id).join('、')}</p>
        <p className={styles.preserve}><strong>判断依据：</strong>{group.reason}</p>
        {group.caution && <p className={styles.muted}>留意差异：{group.caution}</p>}
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => { select(group.ids); void openPreview(group.ids) }}>选入并查看归并预览</button>
          <button type="button" disabled={busy} onClick={() => select(group.ids)}>仅填入勾选框</button>
        </div>
      </section>)}
    </> : <>
      <div className={styles.grid}><div className={styles.compare}><h3>归并前</h3>{preview.sources.map(({ id, last, versions }, i) => <section className={styles.segment} key={id}>
        <strong>{last.title}</strong><p className={styles.muted}>{i === 0 ? '保留为主条目' : '历史保留在回收站'} · {versions} 个版本</p>
        <p className={styles.preserve}>{last.fact}</p>{last.limits && <p className={styles.preserve}>{last.limits}</p>}<EvidenceList evidence={last.evidence} />
      </section>)}</div><div className={styles.compare}><h3>归并后 · 待确认</h3>
        {editing ? <><Field label="主条目标题"><input value={title} maxLength={600} onChange={e => setTitle(e.target.value)} /></Field><Field label="归并正文"><textarea rows={9} value={fact} maxLength={5000} onChange={e => setFact(e.target.value)} /></Field></> : <><strong>{title}</strong><p className={styles.preserve}>{fact}</p></>}
        {preview.article.limits && <p className={styles.preserve}><strong>适用条件与反例：</strong>{preview.article.limits}</p>}
        <EventLinks ids={preview.article.eventIds} events={data.events} open={openEvent} /><EvidenceList evidence={preview.article.evidence} />
      </div></div>
      <p className={styles.muted}>确认后，主条目新增一个版本；其余原条目进入回收站，可恢复。原话和关联事件不丢失。</p>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !title.trim() || !fact.trim()} onClick={async () => {
        const result = await work(() => api<{ id: string }>('/articles/merge', body({ ids: preview.ids, mark: preview.mark, title, fact })), '已归并，旧条目和历史仍可查阅。')
        if (result) open(result.id)
      }}>确认归并</button><button type="button" onClick={() => setEditing(!editing)}>{editing ? '查看正文' : '调整草稿'}</button><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>重新选择</button></div>
    </>}
  </section>
}
