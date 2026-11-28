import type { Evidence } from './types.js'

export const bigFiveThemes = ['extraversion', 'agreeableness', 'conscientiousness', 'negativeEmotionality', 'openness'] as const
export const otherProfileThemes = ['temperament', 'values', 'decisions', 'relationships', 'environment', 'strengths'] as const
export const profileThemes = [...bigFiveThemes, ...otherProfileThemes] as const
export type ProfileStatus = 'self' | 'observation' | 'withdrawn'
export type ProfileRevision = {
  at: string; reason: string; title: string; observation: string; limits: string; status: ProfileStatus; evidence: Evidence[];
}
export type ProfileFinding = {
  id: string; theme: typeof profileThemes[number]; title: string; observation: string; limits: string; question: string;
  status?: ProfileStatus; updatedAt?: string; history?: ProfileRevision[]; revisionReason?: string; evidence: Evidence[]; sources: { kind: 'event' | 'article' | 'context'; id: string; title: string }[];
}
export type ProfileReport = {
  id: string; createdAt: string; updatedAt?: string; method?: 'evidence-big-five'; diaryBatchIds?: string[]; findings: ProfileFinding[];
  coverage: { events: number; articles: number; contexts: number; chats: number; diaries: number; usedDiary: boolean; from: string | null; to: string | null };
}
