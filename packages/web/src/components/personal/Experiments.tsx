import { useState, type FormEvent } from 'react'
import { api, body, day, Field, type Data, type Experiment, type ExperimentStatus, type Work } from './shared.js'
import styles from './Personal.module.css'

const statusLabel: Record<ExperimentStatus, string> = {
  active: '进行中',
  validated: '符合判断',
  refuted: '出现反例',
  inconclusive: '尚无定论',
}

export function ExperimentForm({ data, initialArticleId = '', initialHypothesis = '', work, close }: {
  data: Data; initialArticleId?: string; initialHypothesis?: string; work: Work; close: () => void
}) {
  const [title, setTitle] = useState('')
  const [hypothesis, setHypothesis] = useState(initialHypothesis)
  const [action, setAction] = useState('')
  const [reviewDate, setReviewDate] = useState('')
  const [articleId, setArticleId] = useState(initialArticleId)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (saving || !title.trim() || !hypothesis.trim()) return
    setSaving(true)
    try {
      const saved = await work(
        () => api('/experiments', body({ title: title.trim(), hypothesis: hypothesis.trim(), action: action.trim(), reviewDate, articleId: articleId || undefined })),
        '已记下验证小实验。',
      )
      if (saved) close()
    } finally { setSaving(false) }
  }

  return <form className={styles.form} onSubmit={submit}><fieldset disabled={saving}>
    <Field label="实验名称"><input required maxLength={160} placeholder="例如：下次谈合作前先明确书面退出条约" value={title} onChange={e => setTitle(e.target.value)} /></Field>
    <Field label="想验证的判断"><textarea required rows={2} maxLength={1000} value={hypothesis} onChange={e => setHypothesis(e.target.value)} /></Field>
    <Field label="准备怎么做 / 观察什么"><textarea rows={2} maxLength={1000} placeholder="例如：留意提出这个条件时对方的反应和自己的紧绷感" value={action} onChange={e => setAction(e.target.value)} /></Field>
    <div className={styles.grid}>
      <Field label="计划回顾日期（可选）"><input type="date" value={reviewDate} onChange={e => setReviewDate(e.target.value)} /></Field>
      <Field label="关联百科条目（可选）"><select value={articleId} onChange={e => setArticleId(e.target.value)}><option value="">不关联</option>{data.articles.filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select></Field>
    </div>
    <div className={styles.actions}><button className={styles.primary} type="submit">保存实验</button><button type="button" onClick={close}>取消</button></div>
  </fieldset></form>
}

export function ExperimentList({ experiments, articles, work, busy, onDiscuss, openArticle }: {
  experiments: Experiment[]; articles: Data['articles']; work: Work; busy: boolean; onDiscuss?: (exp: Experiment) => void; openArticle?: (id: string) => void
}) {
  const [editingId, setEditingId] = useState('')
  const [status, setStatus] = useState<ExperimentStatus>('validated')
  const [outcome, setOutcome] = useState('')
  const [reflection, setReflection] = useState('')
  const today = day()
  const byArticle = new Map(articles.filter(a => !a.deleted).map(a => [a.id, a]))

  if (!experiments.length) return null

  return <div className={styles.stack}>{experiments.map(exp => {
    const due = exp.status === 'active' && Boolean(exp.reviewDate) && exp.reviewDate <= today
    const linked = exp.articleId ? byArticle.get(exp.articleId) : undefined
    const isEditing = editingId === exp.id
    return <section key={exp.id} className={styles.compare}>
      <small>{statusLabel[exp.status]}{due ? ' · 到回顾期了' : ''}{exp.reviewDate ? ` · 回顾日期 ${exp.reviewDate}` : ''}</small>
      <h4>{exp.title}</h4>
      <p className={styles.preserve}><strong>想验证：</strong>{exp.hypothesis}</p>
      {exp.action && <p className={styles.preserve}><strong>做法：</strong>{exp.action}</p>}
      {exp.outcome && <p className={styles.preserve}><strong>实际结果：</strong>{exp.outcome}</p>}
      {exp.reflection && <p className={styles.preserve}><strong>回看：</strong>{exp.reflection}</p>}
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => {
          if (isEditing) { setEditingId(''); return }
          setEditingId(exp.id)
          setStatus(exp.status === 'active' ? 'validated' : exp.status)
          setOutcome(exp.outcome)
          setReflection(exp.reflection)
        }}>{isEditing ? '收起记录' : exp.status === 'active' ? '记录结果' : '补充结果'}</button>
        {onDiscuss && <button type="button" disabled={busy} onClick={() => onDiscuss(exp)}>带进对话回访</button>}
        {linked && openArticle && <button type="button" onClick={() => openArticle(linked.id)}>百科 · {linked.title}</button>}
        <button type="button" disabled={busy} onClick={() => { if (confirm('删除这个小实验记录？')) void work(() => api(`/experiments/${exp.id}`, { method: 'DELETE' }), '实验记录已删除。') }}>删除</button>
      </div>
      {isEditing && <form className={styles.form} onSubmit={async e => {
        e.preventDefault()
        if (await work(() => api(`/experiments/${exp.id}`, body({ status, outcome: outcome.trim(), reflection: reflection.trim() }, 'PATCH')), '已记录实验结果。')) setEditingId('')
      }}>
        <Field label="验证结论"><select value={status} onChange={e => setStatus(e.target.value as ExperimentStatus)}>
          <option value="validated">符合原判断</option>
          <option value="refuted">出现反例 / 与原判断不同</option>
          <option value="inconclusive">尚无定论</option>
          <option value="active">继续观察（进行中）</option>
        </select></Field>
        <Field label="实际发生了什么"><textarea rows={2} maxLength={2000} value={outcome} onChange={e => setOutcome(e.target.value)} /></Field>
        <Field label="对自我认识的影响"><textarea rows={2} maxLength={2000} value={reflection} onChange={e => setReflection(e.target.value)} /></Field>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy}>保存结果</button><button type="button" onClick={() => setEditingId('')}>取消</button></div>
      </form>}
    </section>
  })}</div>
}
