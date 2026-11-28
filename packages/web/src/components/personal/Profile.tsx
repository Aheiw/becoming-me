import { bigFiveThemes, otherProfileThemes, type ProfileFinding, type ProfileReport } from '../../../../server/src/personal/profileTypes.js'
import { api, body, Empty, EvidenceList, Page, stamp, type Tab, type Work } from './shared.js'
import styles from './Personal.module.css'

const themes: Record<ProfileFinding['theme'], string> = {
  extraversion: '外向性', agreeableness: '宜人性', conscientiousness: '尽责性', negativeEmotionality: '情绪敏感性', openness: '开放性',
  temperament: '日常节奏与状态', values: '价值观与偏好', decisions: '选择与决策', relationships: '人际关系', environment: '环境与变化', strengths: '能力与优势',
}
const label = { self: '我的自述', observation: 'AI 的待验证观察', withdrawn: '已撤回' }

export default function Profile({ report, go, work, busy }: { report: ProfileReport | null; go: (tab: Tab, id?: string) => void; work: Work; busy: boolean }) {
  const sorted = [...(report?.findings ?? [])].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const current = sorted.filter(f => f.status !== 'withdrawn')
  const changes = sorted.filter(f => f.history?.length)
  const questions = current.filter(f => f.question.trim()).slice(0, 3)
  const discuss = async (f: ProfileFinding) => {
    if (report && await work(() => api('/profile/discuss', body({ reportId: report.id, findingId: f.id })))) go('chat')
  }
  const card = (f: ProfileFinding) => <article className={styles.profileNote} key={f.id}>
    <small>{label[f.status ?? 'observation']}</small><h3>{f.title}</h3>
    <p className={styles.preserve}>{f.observation}</p>
    {f.limits && <p className={styles.muted}>适用条件或反例：{f.limits}</p>}
    <EvidenceList evidence={f.evidence} />
    {f.sources.length > 0 && <div className={styles.actions}>{f.sources.map(s => <button type="button" key={`${s.kind}:${s.id}`} onClick={() => go(s.kind === 'event' ? 'events' : s.kind === 'article' ? 'articles' : 'contexts', s.id)}>{s.title}</button>)}</div>}
    <button type="button" className={styles.link} disabled={busy} onClick={() => void discuss(f)}>补充或纠正</button>
  </article>
  return <Page kicker="成我 / 个人画像" title="关于我" hint="这是一份会随你的讲述和日记分析逐步修订的画像。你的自述和 AI 的理解分开，后者不是定论。" actions={<>
    <button type="button" className={styles.primary} onClick={() => go('chat')}>继续聊天</button><button type="button" onClick={() => go('library')}>日记资料库</button>
  </>}>
    <section className={styles.card}>
      <div className={styles.bookHeading}><div><p className={styles.kicker}>目前的理解</p><h2>我在意什么，又是怎么选择的</h2></div>{report?.updatedAt && <small>更新于 {stamp(report.updatedAt)}</small>}</div>
      {!current.length ? <Empty>还没有画像材料。和平时一样聊，或分析你选择的日记；有明确自述或值得回看的依据时，这里会自动更新。</Empty> : <>
        <div className={styles.profileGrid}>{otherProfileThemes.map(theme => {
          const findings = current.filter(f => f.theme === theme)
          return findings.length ? <section className={styles.profileTheme} key={theme}><h3>{themes[theme]}</h3>{findings.map(card)}</section> : null
        })}</div>
        <details className={styles.details}><summary>从大五看我的经历</summary><p className={styles.muted}>大五是理解经历的一个角度，不是测验得分或诊断。没有依据的维度不下判断。</p>
          <div className={styles.profileGrid}>{bigFiveThemes.map(theme => {
            const findings = current.filter(f => f.theme === theme)
            return <section className={styles.profileTheme} key={theme}><h3>{themes[theme]}</h3>{findings.length ? findings.map(card) : <small>暂无足够依据。</small>}</section>
          })}</div>
        </details>
      </>}
    </section>
    {changes.length > 0 && <section className={styles.card}><p className={styles.kicker}>理解的沿革</p><h2>这些认识怎么变了</h2>
      {changes.map(f => <details key={f.id} className={styles.details}><summary>{f.title}{f.status === 'withdrawn' ? ' · 已撤回' : ''}{f.updatedAt ? ` · ${stamp(f.updatedAt)}` : ''}</summary>
        <p><strong>{f.status === 'withdrawn' ? '为何撤回：' : '现在：'}</strong>{f.observation}</p><EvidenceList evidence={f.evidence} title="本次依据" />
        {[...(f.history ?? [])].reverse().map((r, i) => <div className={styles.profileNote} key={`${r.at}:${i}`}><small>{stamp(r.at)} · {label[r.status]}</small><h3>{r.title}</h3><p className={styles.preserve}>{r.observation}</p>{r.limits && <p className={styles.muted}>{r.limits}</p>}<p><strong>后来为什么改：</strong>{r.reason}</p><EvidenceList evidence={r.evidence} title="原先的依据" /></div>)}
        {f.status === 'withdrawn' && <button type="button" className={styles.link} disabled={busy} onClick={() => void discuss(f)}>聊聊这次撤回</button>}
      </details>)}
    </section>}
    {questions.length > 0 && <section className={styles.card}><p className={styles.kicker}>还没弄清楚</p><h2>值得继续聊的问题</h2>
      {questions.map(f => <div key={f.id} className={styles.profileNote}><small>{f.title}</small><p>{f.question}</p><button type="button" className={styles.link} disabled={busy} onClick={() => void discuss(f)}>在长期对话里聊</button></div>)}
    </section>}
  </Page>
}
