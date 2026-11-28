import { useEffect, useMemo, useState } from 'react'
import { interviewHistoryRequest } from '../../lib/interviewHistory.js'
import { day } from './shared.js'
import styles from './Personal.module.css'

type CalendarEntry = { date: string; batchId: string; index: number; filename: string | null; characters: number }
const number = (value: number) => value.toLocaleString('zh-CN')
const levels = ['0 字', '1–199 字', '200–499 字', '500–999 字', '1,000 字以上']
function heat(count: number) { return count < 1 ? 0 : count < 200 ? 1 : count < 500 ? 2 : count < 1000 ? 3 : 4 }

export default function JournalCalendar({ version, openEntry }: { version: number; openEntry: (batchId: string, index: number) => void }) {
  const [month, setMonth] = useState(() => day().slice(0, 7))
  const [selected, setSelected] = useState('')
  const [result, setResult] = useState<{ month: string; version: number; entries: CalendarEntry[] }>()
  const [error, setError] = useState(''), [attempt, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    interviewHistoryRequest<{ entries: CalendarEntry[] }>(`/diary-calendar?month=${encodeURIComponent(month)}`, { signal: controller.signal }).then(({ entries }) => {
      if (!controller.signal.aborted) setResult({ month, version, entries })
    }).catch(err => { if (!controller.signal.aborted) setError((err as Error).message) })
    return () => controller.abort()
  }, [month, version, attempt])
  const ready = result?.month === month && result.version === version
  const byDay = useMemo(() => {
    const map = new Map<string, { entries: CalendarEntry[]; characters: number }>()
    if (ready) for (const entry of result.entries) {
      const group = map.get(entry.date) ?? { entries: [], characters: 0 }
      group.entries.push(entry); group.characters += entry.characters; map.set(entry.date, group)
    }
    return map
  }, [ready, result])
  const today = day()
  const first = new Date(`${month}-01T00:00:00Z`)
  const next = new Date(first); next.setUTCMonth(first.getUTCMonth() + 1); next.setUTCDate(0)
  const leading = (first.getUTCDay() + 6) % 7
  const picked = byDay.get(selected)
  function move(offset: number) {
    const target = new Date(first); target.setUTCMonth(first.getUTCMonth() + offset)
    setError(''); setSelected(''); setMonth(target.toISOString().slice(0, 7))
  }
  return <section className={styles.card} aria-label="日记月历">
    <div className={styles.bookHeading}>
      <h2>{first.getUTCFullYear()} 年 {first.getUTCMonth() + 1} 月</h2>
      <div className={styles.actions}>
        <button type="button" onClick={() => move(-1)} aria-label="上个月">‹</button>
        <button type="button" onClick={() => { setError(''); setSelected(''); setMonth(today.slice(0, 7)); if (error) retry(n => n + 1) }}>本月</button>
        <button type="button" onClick={() => move(1)} aria-label="下个月">›</button>
      </div>
    </div>
    {error ? <p role="alert" className={styles.error}>{error} <button type="button" onClick={() => { setError(''); retry(n => n + 1) }}>重试</button></p>
      : !ready && <p role="status" className={styles.muted}>正在读取这个月的记录…</p>}
    <div className={styles.journalCalendarGrid}>
      {['一', '二', '三', '四', '五', '六', '日'].map(label => <small key={label} className={styles.journalWeekday}>{label}</small>)}
      {Array.from({ length: leading }, (_, i) => <span key={`empty-${i}`} aria-hidden="true" />)}
      {Array.from({ length: next.getUTCDate() }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, '0')}`, group = byDay.get(date), characters = group?.characters ?? 0
        const label = `${date}，${group?.entries.length ?? 0} 篇，${number(characters)} 字`
        return <button key={date} type="button" className={styles.journalCalendarDay} data-level={heat(characters)} data-today={date === today || undefined}
          aria-label={ready ? label : date} title={ready ? label : date} aria-pressed={selected === date} disabled={!ready || Boolean(error)} onClick={() => setSelected(date)}>{i + 1}</button>
      })}
    </div>
    <div className={styles.journalLegend} aria-label="字数颜色图例"><small>正文越长，颜色越深</small>{levels.map((label, i) => <span key={label} title={label} className={styles.journalSwatch} data-level={i} aria-label={label} />)}</div>
    {ready && selected && <div className={styles.segment}>
      <h3>{selected} · {picked ? `${picked.entries.length} 篇，${number(picked.characters)} 字` : '没有日记'}</h3>
      {picked && <div className={styles.list}>{picked.entries.map((entry, i) => <button key={`${entry.batchId}:${entry.index}`} type="button" onClick={() => openEntry(entry.batchId, entry.index)}>
        <strong>{entry.filename || `当天第 ${i + 1} 篇日记`}</strong><small>{number(entry.characters)} 字 · 查看原文</small>
      </button>)}</div>}
    </div>}
  </section>
}
