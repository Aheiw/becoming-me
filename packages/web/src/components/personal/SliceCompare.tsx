import { useMemo, useState } from 'react'
import { compareSlices, type SliceSnapshot } from '../../../../server/src/personal/sliceCompare.js'
import type { ComparisonSlice } from '../../../../server/src/personal/types.js'
import { Empty, eventTime, Field, type Data, type OpenComparison } from './shared.js'
import styles from './Personal.module.css'

type Option = { value: string; slice: ComparisonSlice; label: string }

function encode(s: ComparisonSlice) { return `${s.kind}:${s.id}` }

export default function SliceCompare({ data, defaultKind, discuss, openEvent, openArticle, busy }: {
  data: Data
  defaultKind: 'context' | 'chapter'
  discuss: OpenComparison
  openEvent: (id: string) => void
  openArticle?: (id: string) => void
  busy: boolean
}) {
  const options = useMemo<Option[]>(() => {
    const contexts: Option[] = data.contexts.map(c => ({
      value: `context:${c.id}`,
      slice: { kind: 'context', id: c.id },
      label: `${c.kind === 'environment' ? '环境' : '人物'} · ${c.name}${c.period ? `（${c.period}）` : ''}`,
    }))
    const chapters: Option[] = [...data.chapters].sort((a, b) => a.order - b.order).map(ch => ({
      value: `chapter:${ch.id}`,
      slice: { kind: 'chapter', id: ch.id },
      label: `阶段 · ${ch.title}`,
    }))
    return defaultKind === 'context' ? [...contexts, ...chapters] : [...chapters, ...contexts]
  }, [data.contexts, data.chapters, defaultKind])

  const preferred = options.filter(o => o.slice.kind === defaultKind)
  const fallbackPool = preferred.length >= 2 ? preferred : options
  const [pickA, setPickA] = useState('')
  const [pickB, setPickB] = useState('')

  const valueA = options.some(o => o.value === pickA) ? pickA : (fallbackPool[0]?.value ?? '')
  const valueB = options.some(o => o.value === pickB) ? pickB : (fallbackPool[1]?.value ?? fallbackPool[0]?.value ?? '')
  const sliceA = options.find(o => o.value === valueA)?.slice
  const sliceB = options.find(o => o.value === valueB)?.slice

  const diff = useMemo(() => {
    if (!sliceA || !sliceB || encode(sliceA) === encode(sliceB)) return null
    return compareSlices(data, data.articles, sliceA, sliceB)
  }, [data, sliceA, sliceB])

  const renderSide = (snap: SliceSnapshot, tag: string) => <div className={`${styles.compare} ${styles.stack}`}>
    <p className={styles.kicker}>{tag} · {snap.subtitle}</p>
    <h4>{snap.title}</h4>
    {snap.summary && <p className={styles.preserve}>{snap.summary}</p>}
    <p className={styles.muted}>关联经历 {snap.events.length} 件 · 关联百科 {snap.articles.length} 条{snap.turningPoints.length ? ` · 观点转折 ${snap.turningPoints.length} 处` : ''}</p>
    {snap.events.length ? snap.events.map(e => <div key={e.id} className={styles.segment}>
      <small>{eventTime(e)}</small>
      <div><button type="button" className={styles.link} onClick={() => openEvent(e.id)}>{e.title}</button></div>
      <p className={styles.preserve}>{e.facts.slice(0, 140)}{e.facts.length > 140 ? '…' : ''}</p>
      {e.outlook && <p className={styles.muted}>当时想法：{e.outlook.slice(0, 120)}{e.outlook.length > 120 ? '…' : ''}</p>}
      {e.evidence[0] && <blockquote className={styles.quote}><p className={styles.preserve}>{e.evidence[0].quote.slice(0, 120)}{e.evidence[0].quote.length > 120 ? '…' : ''}</p></blockquote>}
    </div>) : <p className={styles.muted}>这个切片下还没有挂接事件。</p>}
    {snap.articles.length > 0 && <div className={styles.actions}>
      {snap.articles.map(a => openArticle
        ? <button type="button" key={a.id} onClick={() => openArticle(a.id)}>百科 · {a.title}</button>
        : <span key={a.id} className={styles.muted}>百科 · {a.title}</span>)}
    </div>}
  </div>

  if (options.length < 2) return <Empty>至少建立两个人物、环境或人生阶段档案后，可以在这里并排对比变化与不变之处。</Empty>

  return <div className={styles.stack}>
    <div className={styles.grid}>
      <Field label="切片 A"><select value={valueA} onChange={e => setPickA(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
      <Field label="切片 B"><select value={valueB} onChange={e => setPickB(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
    </div>
    <div className={styles.actions}>
      <button type="button" disabled={!diff || busy} className={styles.primary} onClick={() => diff && discuss({ sliceA: diff.a.slice, sliceB: diff.b.slice })}>带着这组切片去长期对话</button>
      <button type="button" disabled={!sliceA || !sliceB || valueA === valueB} onClick={() => { setPickA(valueB); setPickB(valueA) }}>对调 A / B</button>
    </div>
    {valueA === valueB && <p className={styles.muted}>请选择两个不同的环境、人物或阶段来进行对照。</p>}
    {diff && <>
      <div className={styles.segment}>
        <strong>主题分布对比</strong>
        <p className={styles.muted}>两边都涉及的百科：{diff.sharedArticles.length ? diff.sharedArticles.map(a => a.title).join('、') : '暂无'}</p>
        <p className={styles.muted}>只在「{diff.a.title}」出现：{diff.onlyAArticles.length ? diff.onlyAArticles.map(a => a.title).join('、') : '暂无'}</p>
        <p className={styles.muted}>只在「{diff.b.title}」出现：{diff.onlyBArticles.length ? diff.onlyBArticles.map(a => a.title).join('、') : '暂无'}</p>
      </div>
      <div className={styles.grid}>{renderSide(diff.a, '切片 A')}{renderSide(diff.b, '切片 B')}</div>
    </>}
  </div>
}
