import { eq, inArray, and, like, notLike } from 'drizzle-orm'
import { personalVectors } from '../db/schema.js'
import type { Db } from '../types.js'
import { hash, readArticles } from './store.js'
import type { Evidence, PersonalState } from './types.js'

const MODEL = 'bge-m3:latest'
const OLLAMA = 'http://127.0.0.1:11434'
export type MemoryDoc = { id: string; kind: 'event' | 'article' | 'analysis' | 'diary-text'; sourceId: string; title: string; text: string; at: string; evidence: Evidence[]; relatedEventIds?: string[] }

export async function localEmbeddings(input: string[], signal: AbortSignal) {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal,
    body: JSON.stringify({ model: MODEL, input, truncate: true }),
  })
  if (!response.ok) throw new Error('本地向量模型不可用')
  const { embeddings } = await response.json() as { embeddings?: number[][] }
  if (embeddings?.length !== input.length || !embeddings.every(v => v.length === 1024 && v.every(Number.isFinite))) throw new Error('本地向量返回格式异常')
  return embeddings
}

const searchable = (doc: MemoryDoc) => [doc.title, doc.text, ...doc.evidence.slice(0, 4).map(e => [e.date, e.quote].filter(Boolean).join(' ')), doc.at.slice(0, 10)].join('\n').slice(0, 2600)
function tokens(s: string) {
  const words = s.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/gu) ?? []
  return new Set(words.flatMap(word => /^[a-z\d]/u.test(word) || word.length < 2 ? [word] : [...word].slice(1).map((ch, i) => word[i] + ch)))
}
export function keywordScore(query: string, text: string) {
  const tokensInText = tokens(text)
  const q = [...tokens(query)]
  return q.length ? q.filter(token => tokensInText.has(token)).length / q.length : 0
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i] }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
export async function memoryDocs(db: Db, userId: string, state: PersonalState): Promise<MemoryDoc[]> {
  const articles = await readArticles(db, userId, state)
  return [
    ...state.events.map(e => ({ id: `事件-${e.id}`, kind: 'event' as const, sourceId: e.id, title: e.title,
      text: [e.date && `时间：${e.date}`, e.dateNote, e.topics?.length && `主题：${e.topics.join('、')}`, e.cause && `起因：${e.cause}`, `经过：${e.facts}`, e.outcome && `结果：${e.outcome}`, e.outlook && `当时的自述：${e.outlook}`, e.prediction && `当时的预期：${e.prediction}`, e.impact && `用户记下的影响：${e.impact}`, ...e.followups?.slice(-3).map(f => `回访 ${f.date}：${f.outcome}；事后看法：${f.reflection}`) ?? [], e.analysis && `解释（待核对）：${e.analysis}`].filter(Boolean).join('\n'), at: e.updatedAt, evidence: e.evidence })),
    ...articles.filter(a => !a.deleted).map(a => ({ id: `百科-${a.id}`, kind: 'article' as const, sourceId: a.id,
      title: a.title, text: a.fact, at: a.updatedAt, evidence: a.evidence, relatedEventIds: a.eventIds })),
    ...state.proposals.filter(p => p.origin === 'diary' && p.status === 'pending').map(p => ({ id: `日记分析-${p.id}`, kind: 'analysis' as const,
      sourceId: p.id, title: p.title, text: `日记分析草稿（非事实）：${p.content}\n依据：${p.basis}`, at: p.createdAt, evidence: p.evidence })),
  ].sort((a, b) => b.at.localeCompare(a.at))
}

export async function searchMemory(db: Db, userId: string, docs: MemoryDoc[], question: string, signal?: AbortSignal, scope: 'memory' | 'diary' = 'memory') {
  const minLexical = scope === 'diary' ? 0.12 : Number.EPSILON
  const prepared = docs.map(doc => ({ doc, text: searchable(doc) })).map(item => ({ ...item, lexical: keywordScore(question, item.text) }))
  const select = (ranked: MemoryDoc[]) => {
    const seen = new Set<string>()
    return ranked.filter(doc => {
      if (scope === 'memory') return true
      if (seen.has(doc.sourceId)) return false
      seen.add(doc.sourceId); return true
    }).slice(0, 7)
  }
  const fallback = () => ({ mode: 'keyword' as const, hits: select(prepared.filter(x => x.lexical >= minLexical).sort((a, b) => b.lexical - a.lexical).map(x => x.doc)) })
  if (!prepared.length || process.env.PCE_EMBEDDINGS === '0') return fallback()
  try {
    const limit = AbortSignal.timeout(12_000)
    const combined = signal ? AbortSignal.any([signal, limit]) : limit
    const byScope = (scope === 'diary' ? like : notLike)(personalVectors.documentId, '日记原文-%')
    const cached = await db.select().from(personalVectors).where(and(eq(personalVectors.userId, userId), byScope))
    const vectors = new Map(cached.map(item => [item.documentId, item]))
    const identities = new Set(prepared.map(item => item.doc.id))
    const orphans = scope === 'diary' ? [] : [...vectors.keys()].filter(id => !identities.has(id))
    if (orphans.length) await db.delete(personalVectors).where(and(eq(personalVectors.userId, userId), inArray(personalVectors.documentId, orphans)))
    const items = prepared.map(p => ({ ...p, signature: hash([MODEL, p.text]) }))
    // Warm a few relevant/new documents on each search instead of mass-indexing the diary archive.
    const missing = items.filter(x => vectors.get(x.doc.id)?.signature !== x.signature).sort((a, b) => b.lexical - a.lexical).slice(0, 8)
    const [queryVector, ...newVectors] = await localEmbeddings([question.slice(0, 1800), ...missing.map(x => x.text)], combined)
    const indexed = missing.map((x, i) => ({ userId, documentId: x.doc.id, signature: x.signature, embedding: newVectors[i] }))
    for (const row of indexed) {
      vectors.set(row.documentId, row)
      await db.insert(personalVectors).values(row).onConflictDoUpdate({ target: [personalVectors.userId, personalVectors.documentId], set: { signature: row.signature, embedding: row.embedding } })
    }
    const hits = items.flatMap(p => {
      const row = vectors.get(p.doc.id)
      const semantic = row?.signature === p.signature ? cosine(queryVector, row.embedding) : 0
      return semantic >= (scope === 'diary' ? 0.46 : 0.44) || p.lexical >= minLexical ? [{ doc: p.doc, score: 0.8 * Math.max(semantic, 0) + 0.55 * p.lexical }] : []
    }).sort((a, b) => b.score - a.score).map(p => p.doc)
    return { mode: 'hybrid' as const, hits: select(hits) }
  } catch (error) {
    if (signal?.aborted) throw error
    return fallback()
  }
}
