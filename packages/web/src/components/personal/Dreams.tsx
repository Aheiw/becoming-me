import { useEffect, useState } from 'react'
import SimpleMarkdown from '../SimpleMarkdown.js'
import { api, body, day, Empty, Field, Page, stamp, type Data, type Dream, type Work } from './shared.js'
import styles from './Personal.module.css'

type DreamFields = Pick<Dream, 'title' | 'date' | 'original' | 'feelings' | 'associations'>
export function DreamForm({ initial, onSave, cancel }: { initial?: DreamFields; onSave: (v: DreamFields) => Promise<unknown>; cancel: () => void }) {
  const [v, set] = useState<DreamFields>(initial ?? { title: '', date: day(), original: '', feelings: '', associations: '' }), [saving, setSaving] = useState(false)
  return <form className={styles.form} onSubmit={async e => { e.preventDefault(); setSaving(true); try { await onSave(v) } finally { setSaving(false) } }}><fieldset disabled={saving}>
    <Field label="梦境标题"><input required maxLength={300} value={v.title} onChange={e => set({ ...v, title: e.target.value })} /></Field><Field label="日期"><input value={v.date} pattern="\d{4}(-\d{2}(-\d{2})?)?" onChange={e => set({ ...v, date: e.target.value })} /></Field>
    {([['original', '梦境原文', 24000], ['feelings', '醒后感受', 4500], ['associations', '我自己的联想', 4500]] as const).map(([key, label, max]) => <Field key={key} label={label}><textarea required={key === 'original'} rows={key === 'original' ? 8 : 3} maxLength={max} value={v[key]} onChange={e => set({ ...v, [key]: e.target.value })} /></Field>)}
    <div className={styles.actions}><button type="submit" className={styles.primary}>{saving ? '正在保存…' : '保存到梦境簿'}</button><button type="button" onClick={cancel}>取消</button></div>
  </fieldset></form>
}
export default function Dreams({ data, work, busy, openChat }: { data: Data; work: Work; busy: boolean; openChat: () => void }) {
  const [id, setId] = useState(''), [dream, setDream] = useState<Dream>(), [editor, setEditor] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (!id) return
    const c = new AbortController()
    setError(''); api<Dream>(`/dreams/${id}`, { signal: c.signal }).then(setDream).catch(e => { if (!c.signal.aborted) setError(e.message) })
    return () => c.abort()
  }, [id])
  const current = dream?.id === id ? dream : undefined
  return <Page kicker="独立卷 / 梦境" title="梦境簿" hint="保存梦境原文、醒后感受和你自己的联想。AI 可以提供反思角度，不用梦境给你定性。" actions={<><button type="button" className={styles.primary} onClick={() => { setId(''); setEditor('new') }}>记一个梦</button><a className={styles.button} href="/api/personal/book.zip?volume=dreams">单独导出梦境簿</a></>}>
    <div className={styles.split}><div className={styles.list}>{data.dreams.length ? [...data.dreams].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).map(d => <button type="button" key={d.id} aria-current={id === d.id ? 'true' : undefined} onClick={() => { setEditor(''); setId(d.id) }}><small>{d.date || '日期未知'}</small><strong>{d.title}</strong></button>) : <Empty>还没有梦境。它们不会出现在人生书或普通检索里。</Empty>}</div>
    {editor === 'new' || (current && editor === id) ? <div className={styles.card}><DreamForm key={editor} initial={editor === 'new' ? undefined : current} cancel={() => setEditor('')} onSave={async value => {
      const edit = editor !== 'new' && current
      const saved = await work(() => api<Dream>(`/dreams${edit ? `/${edit.id}` : ''}`, body(value, edit ? 'PATCH' : 'POST')), '梦境已保存在本地。')
      if (saved) { setDream(saved); setId(saved.id); setEditor('') }
    }} /></div> : current ? <article className={styles.card}><p className={styles.kicker}>{current.date || '日期未知'}</p><h2>{current.title}</h2>
      {([['梦境原文', current.original], ['醒后感受', current.feelings], ['我的联想', current.associations]]).map(([label, value]) => value && <div key={label} className={styles.segment}><h3>{label}</h3><p className={styles.preserve}>{value}</p></div>)}
      <div className={styles.actions}><button type="button" onClick={() => setEditor(id)}>编辑原文与感受</button><button disabled={busy} type="button" onClick={async () => { if (!confirm('把这一个梦的原文、感受与联想发送给已配置的 AI API？')) return; const res = await work(() => api<Dream>(`/dreams/${id}/analyze`, body({})), 'AI 联想已保存，仅留在梦境簿。'); if (res) setDream(res) }}>请 AI 提供联想</button><button disabled={busy} type="button" onClick={async () => { if (confirm('带到同一个长期对话？你发送消息时，本梦会随该回合发送给模型；离开梦境焦点后，这些回合不会用于普通对话。') && await work(() => api('/focus', body({ dreamId: id })))) openChat() }}>在长期对话中聊这个梦</button></div>
      {current.notes.map((n, i) => <div className={styles.segment} key={`${n.at}-${i}`}><h3>AI 联想（不是人格判断） · {stamp(n.at)}</h3><SimpleMarkdown>{n.text}</SimpleMarkdown></div>)}
    </article> : <Empty>{error ? <span role="alert">{error}</span> : id ? '正在读取梦境…' : '选一个梦回看，或记下一个新的梦。'}</Empty>}</div>
  </Page>
}
