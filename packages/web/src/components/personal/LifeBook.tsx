import { useMemo, useState } from 'react'
import { bookSections, chapterWeave, eventImportance, importanceLabel, turningEvents } from '../../../../server/src/personal/reading.js'
import { Empty, EvidenceList, Page, eventTime, type Data, type LifeEvent, type OpenComparison } from './shared.js'
import SliceCompare from './SliceCompare.js'
import styles from './Personal.module.css'

export function BookPreview({ data, open }: { data: Data; open: (id?: string) => void }) {
  const sections = useMemo(() => bookSections(data.events, data.chapters), [data.events, data.chapters])
  const turns = useMemo(() => turningEvents(data.turningPoints), [data.turningPoints])
  return <section className={styles.card}><div className={styles.bookHeading}><div><p className={styles.kicker}>人生书 / 目录</p><h2>按阶段读我的人生</h2></div><button className={styles.primary} type="button" onClick={() => open()}>打开人生书</button></div>
    {sections.length ? <div className={styles.bookIndex}>{sections.map(ch => <button key={ch.id} type="button" onClick={() => open(ch.id)}><strong>{ch.title}</strong><small>{ch.events.filter(e => eventImportance(e, turns) !== 'regular').length} 个大事或转折 · {ch.events.length} 个事件</small></button>)}</div>
      : <p className={styles.muted}>还没有章节或事件。记下第一件事之后，这里会出现目录。</p>}
  </section>
}

export default function LifeBook({ data, target, open, openEvent, openArticle, openContext, discuss, busy }: {
  data: Data; target?: string; open: (id?: string) => void; openEvent: (id: string) => void; openArticle: (id: string) => void; openContext?: (id: string) => void; discuss: OpenComparison; busy: boolean
}) {
  const [view, setView] = useState<'main' | 'turning' | 'all'>('main')
  const sections = useMemo(() => bookSections(data.events, data.chapters), [data.events, data.chapters])
  const turns = useMemo(() => turningEvents(data.turningPoints), [data.turningPoints])
  const weaves = useMemo(
    () => new Map(sections.map(ch => [ch.id, chapterWeave(ch.events, data.contexts, data.articles, data.turningPoints)])),
    [sections, data.contexts, data.articles, data.turningPoints],
  )
  const active = sections.find(ch => ch.id === target)
  const includes = (e: LifeEvent) => view === 'all' || (view === 'turning' ? eventImportance(e, turns) === 'turning' : eventImportance(e, turns) !== 'regular')
  return <Page kicker="人生书 / 阅读模式" title="我的人生书" hint="按阶段连贯地读：把经历、当时的人与环境、后来沉淀出的认识和观念转折放在同一章里。">
    <div className={styles.bookLayout}>
      <nav aria-label="人生书目录" className={`${styles.card} ${styles.bookNav}`}><h2>目录</h2><div className={styles.list}>
        <button type="button" aria-pressed={!active} onClick={() => open()}>全书</button>
        {sections.map(ch => {
          const w = weaves.get(ch.id)
          return <button key={ch.id} type="button" aria-pressed={active?.id === ch.id} onClick={() => open(ch.id)}>
            <strong>{ch.title}</strong>
            <small>{ch.events.filter(includes).length} / {ch.events.length} 事件{w?.articles.length ? ` · ${w.articles.length} 条认识` : ''}</small>
          </button>
        })}
      </div></nav>
      <div className={`${styles.card} ${styles.bookPaper}`}>
        <div className={styles.actions} role="group" aria-label="阅读范围">
          <button type="button" aria-pressed={view === 'main'} onClick={() => setView('main')}>大事和转折</button>
          <button type="button" aria-pressed={view === 'turning'} onClick={() => setView('turning')}>只看转折</button>
          <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>全部事件</button>
        </div>
        {!sections.length && <Empty>还没有可以读的事件。<button type="button" onClick={() => openEvent('')}>去事件簿</button></Empty>}
        {(active ? [active] : sections).map(ch => {
          const w = weaves.get(ch.id)!
          return <section className={styles.bookChapter} key={ch.id}>
            <h2>{ch.title}</h2>{ch.introduction && <p className={styles.preserve}>{ch.introduction}</p>}
            {(w.contexts.length > 0 || w.articles.length > 0 || w.turningPoints.length > 0) && <div className={styles.stack}>
              {w.contexts.length > 0 && <div className={styles.segment}>
                <strong>这一阶段的人物与环境</strong>
                <div className={styles.actions}>{w.contexts.map(({ card, count }) => openContext
                  ? <button type="button" key={card.id} onClick={() => openContext(card.id)}>{card.kind === 'person' ? '人物' : '环境'} · {card.name}{card.role ? `（${card.role}）` : ''} · {count} 事</button>
                  : <span key={card.id} className={styles.muted}>{card.name}</span>)}</div>
              </div>}
              {w.articles.length > 0 && <div className={styles.segment}>
                <strong>这一阶段沉淀出的认识 · {w.articles.length} 条</strong>
                <div className={styles.stack}>{w.articles.map(a => <div key={a.id} className={styles.compare}>
                  <button type="button" className={styles.link} onClick={() => openArticle(a.id)}>{a.title}</button>
                  <p className={styles.preserve}>{a.fact}</p>
                  {a.limits && <p className={styles.muted}>边界与反例：{a.limits}</p>}
                </div>)}</div>
              </div>}
              {w.turningPoints.length > 0 && <div className={styles.segment}>
                <strong>观念转折 · {w.turningPoints.length} 处</strong>
                {w.turningPoints.map(tp => <div key={tp.id} className={styles.compare}>
                  <small>{tp.date || '时间未定'}</small>
                  <p className={styles.preserve}>从「{tp.before}」转向「{tp.after}」</p>
                  {tp.why && <p className={styles.muted}>转折原因：{tp.why}</p>}
                </div>)}
              </div>}
            </div>}
            {ch.events.filter(includes).map(e => {
              const eContexts = w.contextsByEvent.get(e.id) ?? []
              const eArticles = w.articlesByEvent.get(e.id) ?? []
              const eTurns = w.turnsByEvent.get(e.id) ?? []
              return <article className={styles.bookEntry} key={e.id}>
                <p className={styles.kicker}>{eventTime(e)}{e.date && e.dateNote ? ` · ${e.date}` : ''} · {importanceLabel[eventImportance(e, turns)]}</p>
                <h3><button className={styles.link} type="button" onClick={() => openEvent(e.id)}>{e.title}</button></h3>
                {e.topics?.length ? <p className={styles.muted}>主题：{e.topics.join('、')}</p> : null}
                {eContexts.length > 0 && <div className={styles.actions}>{eContexts.map(({ card, direct }) => openContext
                  ? <button type="button" key={card.id} onClick={() => openContext(card.id)}>{card.name}{!direct ? '（关系延伸）' : ''}</button>
                  : <span key={card.id} className={styles.muted}>{card.name}</span>)}</div>}
                {e.cause && <p className={styles.preserve}><strong>起因：</strong>{e.cause}</p>}
                <p className={styles.preserve}>{e.facts}</p>
                {e.outlook && <p className={styles.preserve}><strong>当时的想法：</strong>{e.outlook}</p>}
                {e.outcome && <p className={styles.preserve}><strong>实际结果：</strong>{e.outcome}</p>}
                {e.impact && <p className={styles.preserve}><strong>记下的影响：</strong>{e.impact}</p>}
                {eTurns.map(tp => <p key={tp.id} className={styles.muted}>观点转折：从「{tp.before}」转向「{tp.after}」{tp.why ? `（${tp.why}）` : ''}</p>)}
                {eArticles.length > 0 && <div className={styles.actions}>{eArticles.map(a => <button type="button" key={a.id} onClick={() => openArticle(a.id)}>关联百科 · {a.title}</button>)}</div>}
                {!!e.followups?.length && <details className={styles.details}><summary>后来回访 · {e.followups.length}</summary>{e.followups.map(f => <div key={f.id} className={styles.compare}><small>{f.date}</small><p className={styles.preserve}>{f.outcome}</p>{f.reflection && <p className={styles.preserve}>事后回看：{f.reflection}</p>}</div>)}</details>}
                <EvidenceList evidence={e.evidence} />
              </article>
            })}
            {!ch.events.some(includes) && <p className={styles.muted}>{!ch.events.length ? '这个阶段还没有事件。' : view === 'turning' ? '这个阶段还没有标记为转折的事件。' : '这个阶段还没有标记为大事或转折的事件。'}</p>}
          </section>
        })}
        {view !== 'all' && (active ? active.events.length : data.events.length) > 0 && !(active ? active.events : data.events).some(includes) && <button type="button" onClick={() => setView('all')}>查看未标记的事件</button>}
      </div>
    </div>
    <details className={styles.details}><summary>按阶段或环境对照变化（哪些地方变了、哪些没变）</summary>
      <SliceCompare data={data} defaultKind="chapter" discuss={discuss} openEvent={openEvent} openArticle={openArticle} busy={busy} />
    </details>
  </Page>
}
