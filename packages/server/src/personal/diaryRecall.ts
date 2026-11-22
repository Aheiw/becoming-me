import { desc, eq } from 'drizzle-orm'
import { diaryEntries, interviewDiaryBatches } from '../db/schema.js'
import type { Db } from '../types.js'
import type { Evidence } from './types.js'
import { hash } from './store.js'
import { searchMemory, type MemoryDoc } from './search.js'

export function diaryIntent(message: string, selected: boolean) {
  const mentioned = /日记|手记|日志|diar(?:y|ies)/i.test(message)
  const extractEvents = /事件|经历|转折/u.test(message) && /记录|提取|整理|找|列|归档|写入|收集|总结|捋/u.test(message)
  const optedOut = /(?:别|不要|不用|无需)(?:再|去|用)?(?:查|读|看|搜|参考|翻|引用)(?:我的|旧的|以前的)?日记/u.test(message)
  const referringToText = /查|读|看|检索|翻|搜|根据|结合|参考|原文|原话|提到|写[过了的]|日记[里中]|日记[内上]|日记.*(?:记|有)/u.test(message)
  return { lookup: !optedOut && ((mentioned && (referringToText || extractEvents)) || (selected && extractEvents)), extractEvents, all: /全部|所有|整个日记库/u.test(message) }
}

export async function recallDiary(db: Db, userId: string, message: string, opts: { batchId?: string; extractEvents: boolean; signal: AbortSignal }) {
  const [batches, saved] = await Promise.all([
    db.select({ id: interviewDiaryBatches.id, entries: interviewDiaryBatches.entries, createdAt: interviewDiaryBatches.createdAt })
      .from(interviewDiaryBatches).where(eq(interviewDiaryBatches.userId, userId)).orderBy(desc(interviewDiaryBatches.createdAt)),
    opts.batchId ? Promise.resolve([]) : db.select().from(diaryEntries).where(eq(diaryEntries.userId, userId)),
  ])
  const unique = new Map<string, { content: string; source: Omit<Evidence, 'quote'>; at: Date }>()
  const add = (content: string, source: Omit<Evidence, 'quote'>, at: Date) => {
    if (!content.trim()) return
    const key = hash([source.date, content.trim()])
    if (!unique.has(key)) unique.set(key, { content, source, at })
  }
  for (const batch of batches) if (!opts.batchId || batch.id === opts.batchId) {
    batch.entries.forEach((entry, index) => add(entry.content, { kind: 'diary', id: batch.id, index, date: entry.date, label: entry.filename ?? undefined }, batch.createdAt))
  }
  for (const row of saved) add(row.content, { kind: 'saved-diary', id: row.id, date: row.entryDate, label: row.filename ?? undefined }, row.createdAt)
  const dates = [...message.matchAll(/(?<!\d)(\d{4})(?:\s*(?:年|-|\/|\.)\s*(\d{1,2})(?:\s*(?:月|-|\/|\.)\s*(\d{1,2}))?)?(?!\d)/g)]
    .map(([, year, month, day]) => [year, month?.padStart(2, '0'), day?.padStart(2, '0')].filter(Boolean).join('-'))
  const scoped = [...unique].filter(([, d]) => !dates.length || dates.some(date => d.source.date?.startsWith(date)))
  const docs = scoped.flatMap(([key, entry]): MemoryDoc[] => {
    const result: MemoryDoc[] = []
    // Offset-based slices retain byte-for-byte source text, including line breaks.
    for (let start = 0; start < entry.content.length; start += 900) {
      const quote = entry.content.slice(start, start + 1150).trim()
      if (quote) result.push({ id: `日记原文-${key}-${start}`, kind: 'diary-text', sourceId: key, title: [entry.source.date, entry.source.label].filter(Boolean).join(' · ') || '未署日期的日记',
        text: quote, at: entry.at.toISOString(), evidence: [{ ...entry.source, quote }] })
    }
    return result
  })
  const topic = message.replace(/(?<!\d)\d{4}(?:\s*(?:年|-|\/|\.)\s*\d{1,2}(?:\s*(?:月|-|\/|\.)\s*\d{1,2})?)?[年月日]?/g, ' ')
    .replace(/查(?:阅|找|询)?|读|翻(?:翻|阅)?|检索|搜(?:索)?|看(?:看|一下)?|以前|之前|过去|已保存|已上传|全部|所有|整个|日记(?:库|原文)?|手记|日志|diar(?:y|ies)|原话|我的|我在|我对|我怎么|怎么|帮我|请|里面|里边|这批|从|关于|哪些|什么|说过|写过|提过|当时|记了|有没有|出来|一下子|一下|的|了|里|吗|把|和|中/giu, ' ').trim()
  const specific = opts.extractEvents ? topic.replace(/提取|记录|整理|事件|经历|转折|重要|值得|主要|汇总|归档|列出|找出|写入/g, ' ').trim() : topic
  const hasTopic = /[\p{L}\p{N}]/u.test(specific)
  const hits = docs.length && hasTopic ? (await searchMemory(db, userId, docs, specific, opts.signal, 'diary')).hits : []
  // A broad request is a bounded preview, not a claim to have read every entry.
  const fallback = !hasTopic ? [...docs].sort((a, b) => (b.evidence[0].date ?? '').localeCompare(a.evidence[0].date ?? '')) : []
  const found = [...new Map([...hits, ...fallback].reverse().map(d => [d.sourceId, d])).values()].reverse().slice(0, 5)
  return { hits: found, dateFilters: dates, available: unique.size, scanned: scoped.length, hasTopic }
}

export function isPersonalDream(message: string) {
  if (/^\s*(?:假如|如果|比如|举例|假设|有人|你(?:说|会|觉得))|梦到(?:……|\.\.\.)\s*[」”"']?\s*(?:怎么|会|可以|能)/u.test(message)) return false
  return /(?:^|[，。！？；\n])\s*(?:(?:我\s*)?(?:昨晚|昨天晚上|今天早上|今早|刚才|午睡时|前几天|那晚|那天晚上)\s*(?:我\s*)?|我\s*)(?:又|还|曾经|好像|刚刚|刚)?\s*(?:梦[到见]|做了(?:一)?个梦|做梦梦见)(?=.{2})|^\s*(?:梦境记录|梦境[：:]|记个梦[：:，])/su.test(message)
}
