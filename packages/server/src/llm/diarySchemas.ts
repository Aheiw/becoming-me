import { z } from 'zod'
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
export const diaryAnalysisItemSchema = diarySuggestionSchema.extend({
  basis: textWithoutNull(350),
  title: z.string().max(160).optional(),
  eventDraft: z.object({ date: z.string().regex(/^(?:\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)?$/).or(z.literal('')), cause: z.string().max(700), outcome: z.string().max(700) }).nullable().optional(),
})

export type DiaryEntry = z.infer<typeof diaryEntrySchema>
export type DiarySuggestion = z.infer<typeof diarySuggestionSchema>
export type DiaryAnalysisItem = z.infer<typeof diaryAnalysisItemSchema>

// Source numbers are one-based and refer to the original uploaded list, even after sorting for analysis.
export function citationsMatch(entries: DiaryEntry[], suggestion: DiarySuggestion): boolean {
  return suggestion.citations.every(({ source, quote }) => entries[source - 1]?.content.includes(quote))
}

export function uniqueCitations(citations: DiarySuggestion['citations']): DiarySuggestion['citations'] {
  return citations.filter((citation, i) => citations.findIndex(other => other.source === citation.source && other.quote === citation.quote) === i)
}
