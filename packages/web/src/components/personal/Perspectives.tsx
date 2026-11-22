import { useState } from 'react'
import { EvidenceList, eventTime, stamp, type ArticleRow, type LifeEvent, type OpenComparison } from './shared.js'
import styles from './Personal.module.css'

export default function Perspectives({ events, articles, fixedEvent, fixedArticle, openEvent, openArticle, discuss, busy }: { events: LifeEvent[]; articles: ArticleRow[]; fixedEvent?: LifeEvent; fixedArticle?: ArticleRow; openEvent?: (id: string) => void; openArticle?: (id: string) => void; discuss: OpenComparison; busy: boolean }) {
  const [eventId, selectEvent] = useState(''), [articleId, selectArticle] = useState('')
  const event = fixedEvent ?? events.find(e => e.id === eventId) ?? events[0]
  const article = fixedArticle ?? articles.find(a => a.id === articleId) ?? articles[0]
  return <section className={styles.segment} aria-label="当时与现在对照">
    <div className={styles.bookHeading}><h3>当时的我 / 现在的理解</h3><button type="button" disabled={busy || (!event && !article)} onClick={() => discuss({ eventId: event?.id, articleId: article?.id })}>带着这些资料继续聊</button></div>
    <div className={styles.grid}>
      <div className={`${styles.compare} ${styles.stack}`}><h4>当时的我</h4>
        {!fixedEvent && events.length > 1 && <select aria-label="对照哪件事" value={event?.id} onChange={e => selectEvent(e.target.value)}>{events.map(e => <option value={e.id} key={e.id}>{eventTime(e)} · {e.title}</option>)}</select>}
        {event ? <><p className={styles.kicker}>{eventTime(event)} · {event.title}</p>
          {event.outlook && <p className={styles.preserve}><strong>记下的当时想法：</strong>{event.outlook}</p>}
          {event.evidence.length ? <><blockquote className={styles.quote}><small>记录日期：{event.evidence[0].date ?? '未知'}</small><p className={styles.preserve}>{event.evidence[0].quote}</p></blockquote><EvidenceList evidence={event.evidence} title="查看引文及原文" /></> : <p className={styles.muted}>这件事没有附原话，不能把现在的解释当成当时的自述。</p>}
          {!fixedEvent && openEvent && <button className={styles.link} type="button" onClick={() => openEvent(event.id)}>打开事件详情</button>}
        </> : <p className={styles.muted}>这个条目还没关联具体事件，可在编辑条目时补充。</p>}
      </div>
      <div className={`${styles.compare} ${styles.stack}`}><h4>现在的理解</h4>
        {!fixedArticle && articles.length > 1 && <select aria-label="对照哪个百科条目" value={article?.id} onChange={e => selectArticle(e.target.value)}>{articles.map(a => <option value={a.id} key={a.id}>{a.title}</option>)}</select>}
        {article ? <><p className={styles.kicker}>{article.title} · {stamp(article.updatedAt)} 修订</p><p className={styles.preserve}>{article.fact}</p>
          {!fixedArticle && openArticle && <button className={styles.link} type="button" onClick={() => openArticle(article.id)}>查看百科与修订历史</button>}
        </> : <p className={styles.muted}>这件事还没关联正式百科；事件解读不等于已确认的认识。</p>}
      </div>
    </div>
  </section>
}
