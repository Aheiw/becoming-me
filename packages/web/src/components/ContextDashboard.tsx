import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CATEGORY_TO_LAYER } from '../constants/layers.js'
import type { ProgressData } from './ProgressHeader.js'
import { DiaryEvidence, type DiaryCitation } from './DiaryEvidence.js'
import styles from './ContextDashboard.module.css'

interface ContextFact {
  id: string
  category: string
  fact: string
  diaries?: DiaryCitation[]
}

interface ContextSummary {
  facts: ContextFact[]
  timeline: { year: number; month: number | null; description: string }[]
  professional?: { id: string; company: string; role: string | null; startYear: number; endYear: number | null; description: string | null; skills: string | null }[]
}

const GROUPS = {
  CORE: ['L1', 'L2'],
  SHAPE: ['L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
  STATE: ['L9', 'L10'],
} as const

interface Props {
  onStartInterview: () => void
  onAddDiaries?: () => void
}

export default function ContextDashboard({ onStartInterview, onAddDiaries }: Props) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<ProgressData | null>(null)
  const [summary, setSummary] = useState<ContextSummary | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [topic, setTopic] = useState('L1')

  useEffect(() => {
    const controller = new AbortController()
    async function read<T>(url: string): Promise<T> {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error()
      return response.json() as Promise<T>
    }
    Promise.all([
      read<ProgressData>('/api/progress'),
      read<ContextSummary>('/api/context-summary?view=encyclopedia'),
    ]).then(([progressData, summaryData]) => {
      if (controller.signal.aborted) return
      setProgress(progressData)
      setSummary(summaryData)
      setStatus('ready')
    }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    return () => controller.abort()
  }, [attempt])

  const timeline = [...(summary?.timeline ?? [])].sort((a, b) => a.year - b.year || (a.month ?? 0) - (b.month ?? 0))
  const professional = summary?.professional ?? []
  const facts = summary?.facts.filter(fact => CATEGORY_TO_LAYER[fact.category] === topic) ?? []
  const selectedLayer = progress?.layers.find(layer => layer.id === topic)
  const layerCount = (id: string) => (summary?.facts.filter(f => CATEGORY_TO_LAYER[f.category] === id).length ?? 0)
    + (id === 'L3' ? timeline.length : id === 'L4' ? professional.length : 0)

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>{t('app.nav.myContext')}</p>
          <h1>{t('dashboard.encyclopedia', { defaultValue: 'Personal encyclopedia' })}</h1>
          <p>{t('dashboard.intro', { defaultValue: 'Browse what you know about yourself, organized by topic.' })}</p>
        </div>
        <button className={styles.primary} onClick={onStartInterview}>{t('dashboard.continueInterview')} <span aria-hidden="true">→</span></button>
      </header>
      <div className={styles.layout}>
        <nav className={styles.directory} aria-label={t('dashboard.topicIndex', { defaultValue: 'Topic index' })}>
          <h2>{t('dashboard.topicIndex', { defaultValue: 'Topic index' })}</h2>
          {Object.entries(GROUPS).map(([zone, ids]) => (
            <div key={zone} className={styles.group}>
              <h3>{t(`progress.zones.${zone}`)}</h3>
              {ids.map(id => (
                <button type="button" key={id} className={styles.topic} aria-current={topic === id ? 'true' : undefined} onClick={() => setTopic(id)}>
                  <span className={styles.index}>{id.slice(1).padStart(2, '0')}</span>
                  <span>{t(`dashboard.layers.${id}`)}</span>
                  {status === 'ready' && <span className={styles.count}>{layerCount(id)}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <article className={styles.chapter} aria-labelledby="pce-topic-title">
          <div className={styles.chapterHead}>
            <span className={styles.eyebrow}>{t('dashboard.topicNumber', { number: topic.slice(1).padStart(2, '0'), defaultValue: 'Topic {{number}}' })}</span>
            <h2 id="pce-topic-title">{t(`dashboard.layers.${topic}`)}</h2>
            {selectedLayer && <span className={styles.chapterMeta}>{t('progress.label')} · {Math.round(selectedLayer.percent)}%</span>}
          </div>
          {status === 'loading' && <p className={styles.empty} role="status">{t('dashboard.loading')}</p>}
          {status === 'error' && <div className={styles.empty} role="alert">
            <p>{t('dashboard.loadError', { defaultValue: 'Could not load your encyclopedia.' })}</p>
            <button className={styles.textButton} onClick={() => { setStatus('loading'); setAttempt(n => n + 1) }}>{t('dashboard.retry', { defaultValue: 'Retry' })}</button>
          </div>}
          {status === 'ready' && <>
            {topic === 'L3' && timeline.length > 0 && <div className={styles.timeline}>
              <h3>{t('dashboard.timelineHeading')}</h3>
              <ol>{timeline.map((e, i) => <li key={i}>
                <time>{e.year}{e.month ? `/${String(e.month).padStart(2, '0')}` : ''}</time><span>{e.description}</span>
              </li>)}</ol>
            </div>}
            {topic === 'L4' && professional.length > 0 && <ol className={styles.entries}>
              {professional.map(record => <li key={record.id}>
                <p className={styles.chapterMeta}>{record.startYear} — {record.endYear ?? t('dashboard.present', { defaultValue: 'Present' })}</p>
                <h3><strong>{record.company}{record.role && ` · ${record.role}`}</strong></h3>
                {record.description && <p>{record.description}</p>}
                {record.skills && <p>{t('dashboard.skills', { defaultValue: 'Skills' })}：{record.skills}</p>}
              </li>)}
            </ol>}
            {facts.length > 0 && <ol className={styles.entries}>
              {facts.map(f => <li key={f.id}>
                {f.diaries?.length ? <DiaryEvidence citations={f.diaries} fact={f.fact} /> : <p>{f.fact}</p>}
              </li>)}
            </ol>}
            {!layerCount(topic) && <div className={styles.empty}>
              <h3>{t('dashboard.noData')}</h3>
              <p>{t('dashboard.emptyTopic', { defaultValue: 'This topic will fill in as you add to your encyclopedia.' })}</p>
              {onAddDiaries && <button type="button" className={styles.textButton} onClick={onAddDiaries}>{t('app.nav.diary', { defaultValue: 'Analyze diaries' })} <span aria-hidden="true">→</span></button>}
            </div>}
          </>}
        </article>
      </div>
    </div>
  )
}
