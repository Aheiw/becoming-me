import { jsonSchema, NoObjectGeneratedError, zodSchema } from 'ai'
import { articleChapterIds } from '../personal/articleTopics.js'
import { z } from 'zod'
import { profileDraftSchema } from '../personal/profile.js'
import { profileThemes } from '../personal/profileTypes.js'
import { STRUCTURED_FACT_CATEGORIES } from '../db/schema.js'

export const MAX_SUGGESTIONS = 12
export const MAX_CITATIONS = 6

const hasText = (text: string) => text.trim().length > 0 && !text.includes('\0')
const textWithoutNull = (max: number) => z.string().max(max).refine(hasText)

const diaryEntrySchema = z.object({
  date: z.string().date().nullable().default(null),
  filename: textWithoutNull(260).nullable().default(null),
  content: z.string().refine(hasText),
})

export const diaryEntriesSchema = z.array(diaryEntrySchema).min(1)

const topicFields = {
  category: z.enum(STRUCTURED_FACT_CATEGORIES),
  fact: textWithoutNull(400),
}

export const diarySuggestionSchema = z.object({
  ...topicFields,
  citations: z.array(z.object({
    source: z.number().int().positive(),
    quote: textWithoutNull(600),
  })).min(1).max(MAX_CITATIONS),
})
const subject = z.object({ kind: z.enum(['person', 'environment']), name: textWithoutNull(160) })
const cardFields = { role: z.string().max(200), period: z.string().max(120), description: z.string().max(900) }
export const diaryContextDraft = z.union([
  subject.extend({ kind: z.literal('person'), ...cardFields }),
  subject.extend({ kind: z.literal('environment'), ...cardFields }),
  z.object({ kind: z.literal('relation'), from: subject, to: subject, label: textWithoutNull(160), period: z.string().max(120) }),
])
export type DiaryContextDraft = z.infer<typeof diaryContextDraft>
const EVENT_DATE_RE = /^(?:\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)?$/
export const diaryAnalysisItemSchema = diarySuggestionSchema.extend({
  basis: textWithoutNull(350),
  contextDraft: diaryContextDraft.nullable().optional(),
  profileDraft: profileDraftSchema.nullable().optional(),
  title: z.string().max(160).optional(),
  articleId: z.string().max(120).nullable().optional(),
  chapter: z.enum(articleChapterIds).nullable().optional(),
  hypothesis: z.boolean().nullable().optional(),
  counterpoint: z.string().max(500).nullable().optional(),
  eventDraft: z.object({ date: z.string().regex(EVENT_DATE_RE).or(z.literal('')), cause: z.string().max(700), outcome: z.string().max(700) }).nullable().optional(),
})

// Strict Responses JSON schemas require every defined property to be required.
// Omit length/regex bounds on the wire so slightly verbose outputs can be normalized per item.
export const diaryModelItemSchema = diaryAnalysisItemSchema.required()

const wireSubject = z.object({ kind: z.enum(['person', 'environment']), name: z.string() }).required()
const wireContextDraft = z.union([
  wireSubject.extend({ kind: z.literal('person'), role: z.string(), period: z.string(), description: z.string() }).required(),
  wireSubject.extend({ kind: z.literal('environment'), role: z.string(), period: z.string(), description: z.string() }).required(),
  z.object({ kind: z.literal('relation'), from: wireSubject, to: wireSubject, label: z.string(), period: z.string() }).required(),
])
const wireProfileDraft = z.object({
  targetId: z.string().nullable(),
  theme: z.enum(profileThemes),
  kind: z.enum(['self', 'observation', 'correct', 'withdraw']),
  limits: z.string(),
  question: z.string(),
}).required()
const wireEventDraft = z.object({ date: z.string(), cause: z.string(), outcome: z.string() }).required()

const diaryWireZodSchema = z.object({
  category: z.enum(STRUCTURED_FACT_CATEGORIES),
  fact: z.string(),
  citations: z.array(z.object({ source: z.number().int(), quote: z.string() }).required()),
  basis: z.string(),
  contextDraft: wireContextDraft.nullable(),
  profileDraft: wireProfileDraft.nullable(),
  title: z.string(),
  articleId: z.string().nullable(),
  chapter: z.enum(articleChapterIds).nullable(),
  hypothesis: z.boolean().nullable(),
  counterpoint: z.string().nullable(),
  eventDraft: wireEventDraft.nullable(),
}).required()

export type DiaryEntry = z.infer<typeof diaryEntrySchema>
export type DiarySuggestion = z.infer<typeof diarySuggestionSchema>
export type DiaryAnalysisItem = z.infer<typeof diaryAnalysisItemSchema>

const CATEGORY_SET = new Set<string>(STRUCTURED_FACT_CATEGORIES)
const CHAPTER_SET = new Set<string>(articleChapterIds)
const PROFILE_THEME_SET = new Set<string>(profileThemes)
const PROFILE_KIND_SET = new Set<string>(['self', 'observation', 'correct', 'withdraw'])

const cleanStr = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replaceAll('\0', '').trim().slice(0, max) : ''

function normalizeEventDate(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = raw.replaceAll('\0', '').trim()
  if (!s) return ''
  if (EVENT_DATE_RE.test(s)) return s
  const ymd = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (ymd) {
    const candidate = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
    return EVENT_DATE_RE.test(candidate) ? candidate : ''
  }
  const ym = s.match(/^(\d{4})[./-](\d{1,2})$/)
  if (ym) {
    const candidate = `${ym[1]}-${ym[2].padStart(2, '0')}`
    return EVENT_DATE_RE.test(candidate) ? candidate : ''
  }
  return ''
}

function normalizeContextDraft(raw: unknown): DiaryContextDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'person' || r.kind === 'environment') {
    const name = cleanStr(r.name, 160)
    if (!name) return null
    return {
      kind: r.kind,
      name,
      role: cleanStr(r.role, 200),
      period: cleanStr(r.period, 120),
      description: cleanStr(r.description, 900),
    }
  }
  if (r.kind === 'relation') {
    const from = r.from as Record<string, unknown> | undefined
    const to = r.to as Record<string, unknown> | undefined
    const label = cleanStr(r.label, 160)
    if (!from || !to || !label) return null
    if ((from.kind !== 'person' && from.kind !== 'environment') || (to.kind !== 'person' && to.kind !== 'environment')) return null
    const fromName = cleanStr(from.name, 160), toName = cleanStr(to.name, 160)
    if (!fromName || !toName) return null
    return {
      kind: 'relation',
      from: { kind: from.kind, name: fromName },
      to: { kind: to.kind, name: toName },
      label,
      period: cleanStr(r.period, 120),
    }
  }
  return null
}

function normalizeProfileDraft(raw: unknown): DiaryAnalysisItem['profileDraft'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.theme !== 'string' || !PROFILE_THEME_SET.has(r.theme)) return null
  if (typeof r.kind !== 'string' || !PROFILE_KIND_SET.has(r.kind)) return null
  return {
    targetId: typeof r.targetId === 'string' && r.targetId.trim() ? cleanStr(r.targetId, 80) : null,
    theme: r.theme as NonNullable<DiaryAnalysisItem['profileDraft']>['theme'],
    kind: r.kind as NonNullable<DiaryAnalysisItem['profileDraft']>['kind'],
    limits: cleanStr(r.limits, 400),
    question: cleanStr(r.question, 400),
  }
}

function normalizeEventDraft(raw: unknown): DiaryAnalysisItem['eventDraft'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  return {
    date: normalizeEventDate(r.date),
    cause: cleanStr(r.cause, 700),
    outcome: cleanStr(r.outcome, 700),
  }
}

export function normalizeDiaryItem(raw: unknown): DiaryAnalysisItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const category = typeof r.category === 'string' && CATEGORY_SET.has(r.category)
    ? r.category as DiaryAnalysisItem['category']
    : null
  const fact = cleanStr(r.fact, 400)
  if (!category || !fact) return null
  if (!Array.isArray(r.citations)) return null
  const citations = r.citations
    .map(c => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return null
      const rec = c as Record<string, unknown>
      const source = typeof rec.source === 'number' ? rec.source : Number(rec.source)
      const quote = typeof rec.quote === 'string' ? rec.quote.replaceAll('\0', '').slice(0, 600) : ''
      if (!Number.isInteger(source) || source < 1 || !quote.trim()) return null
      return { source, quote }
    })
    .filter((c): c is { source: number; quote: string } => c !== null)
    .slice(0, MAX_CITATIONS)
  if (!citations.length) return null

  const basis = cleanStr(r.basis, 350) || '基于本批原文提取。'
  const out: DiaryAnalysisItem = { category, fact, citations, basis }

  if ('title' in r && typeof r.title === 'string') out.title = cleanStr(r.title, 160)
  if ('articleId' in r) out.articleId = typeof r.articleId === 'string' && r.articleId.trim() ? cleanStr(r.articleId, 120) : null
  if ('chapter' in r) out.chapter = typeof r.chapter === 'string' && CHAPTER_SET.has(r.chapter) ? r.chapter as NonNullable<DiaryAnalysisItem['chapter']> : null
  if ('hypothesis' in r) out.hypothesis = typeof r.hypothesis === 'boolean' ? r.hypothesis : null
  if ('counterpoint' in r) out.counterpoint = typeof r.counterpoint === 'string' && r.counterpoint.trim() ? cleanStr(r.counterpoint, 500) : null
  if ('eventDraft' in r) out.eventDraft = r.eventDraft === null ? null : normalizeEventDraft(r.eventDraft)
  if ('contextDraft' in r) out.contextDraft = r.contextDraft === null ? null : normalizeContextDraft(r.contextDraft)
  if ('profileDraft' in r) out.profileDraft = r.profileDraft === null ? null : normalizeProfileDraft(r.profileDraft)

  return out
}

export const diaryWireJsonSchema = zodSchema(diaryWireZodSchema).jsonSchema

export const diaryTolerantItemSchema = jsonSchema<DiaryAnalysisItem>(diaryWireJsonSchema, {
  validate(value) {
    const normalized = normalizeDiaryItem(value)
    if (!normalized) {
      return { success: false, error: new Error('Invalid diary analysis item') }
    }
    return { success: true, value: normalized }
  },
})

function stripThinkingAndFences(raw: string): string {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : withoutThink).trim()
}

function findBalancedJson(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      const expected = stack.pop()
      if (ch !== expected) return null
      if (!stack.length) return text.slice(start, i + 1)
    }
  }
  return null
}

export function extractDiaryItemsFromText(rawText: string, response?: { id: string; timestamp: Date; modelId: string }): DiaryAnalysisItem[] {
  const cleaned = stripThinkingAndFences(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const candidate = findBalancedJson(cleaned)
    if (!candidate) {
      throw new NoObjectGeneratedError({
        message: 'No object generated: could not parse JSON from text response.',
        text: rawText,
        response: response ?? { id: 'text-fallback', timestamp: new Date(), modelId: 'unknown' },
        usage: { promptTokens: NaN, completionTokens: NaN, totalTokens: NaN },
        finishReason: 'stop',
      })
    }
    try {
      parsed = JSON.parse(candidate)
    } catch (cause) {
      throw new NoObjectGeneratedError({
        message: 'No object generated: could not parse extracted JSON.',
        cause: cause instanceof Error ? cause : new Error(String(cause)),
        text: rawText,
        response: response ?? { id: 'text-fallback', timestamp: new Date(), modelId: 'unknown' },
        usage: { promptTokens: NaN, completionTokens: NaN, totalTokens: NaN },
        finishReason: 'stop',
      })
    }
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { elements?: unknown }).elements))
      ? (parsed as { elements: unknown[] }).elements
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items))
        ? (parsed as { items: unknown[] }).items
        : null

  if (!rawList) {
    throw new NoObjectGeneratedError({
      message: 'No object generated: JSON payload does not contain an array of items.',
      text: rawText,
      response: response ?? { id: 'text-fallback', timestamp: new Date(), modelId: 'unknown' },
      usage: { promptTokens: NaN, completionTokens: NaN, totalTokens: NaN },
      finishReason: 'stop',
    })
  }

  const normalized = rawList.map(normalizeDiaryItem).filter((item): item is DiaryAnalysisItem => item !== null)
  if (rawList.length > 0 && normalized.length === 0) {
    throw new NoObjectGeneratedError({
      message: 'No object generated: no valid diary analysis items in array.',
      text: rawText,
      response: response ?? { id: 'text-fallback', timestamp: new Date(), modelId: 'unknown' },
      usage: { promptTokens: NaN, completionTokens: NaN, totalTokens: NaN },
      finishReason: 'stop',
    })
  }
  return normalized
}

// Source numbers are one-based and refer to the original uploaded list, even after sorting for analysis.
export function citationsMatch(entries: DiaryEntry[], suggestion: DiarySuggestion): boolean {
  return suggestion.citations.every(({ source, quote }) => entries[source - 1]?.content.includes(quote))
}

export function uniqueCitations(citations: DiarySuggestion['citations']): DiarySuggestion['citations'] {
  return citations.filter((citation, i) => citations.findIndex(other => other.source === citation.source && other.quote === citation.quote) === i)
}
