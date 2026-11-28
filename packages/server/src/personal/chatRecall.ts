import type { Db } from '../types.js'
import { searchMemory, type MemoryDoc } from './search.js'

const chunkSize = 540
const overlap = 80
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

type ChatLine = { id: string; role: string; content: string; createdAt: Date }

/** The caller supplies the active user's long chat. Assistant replies and private turns aren't evidence. */
export async function recallChat(db: Db, userId: string, history: ChatLine[], query: string, period: string, signal: AbortSignal) {
  const datePrefix = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(period) ? period : ''
  const docs: MemoryDoc[] = []
  for (const row of history) {
    if (row.role !== 'user') continue
    const date = dateFormat.format(row.createdAt)
    if (datePrefix && !date.startsWith(datePrefix)) continue
    for (let offset = 0; offset < row.content.length; offset += chunkSize - overlap) {
      const quote = row.content.slice(offset, offset + chunkSize).trim()
      if (quote) docs.push({ id: `对话原文-${row.id}:${offset}`, kind: 'chat-text', sourceId: row.id, title: '长期对话', text: quote,
        at: row.createdAt.toISOString(), evidence: [{ kind: 'chat', id: row.id, quote, date }] })
      if (offset + chunkSize >= row.content.length) break
    }
  }
  return searchMemory(db, userId, docs, query, signal, 'chat')
}
