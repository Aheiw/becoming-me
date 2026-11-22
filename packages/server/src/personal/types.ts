export type Evidence = {
  kind: 'diary' | 'chat' | 'saved-diary'; id: string; index?: number; quote: string; date: string | null; label?: string
}
export type EventImportance = 'regular' | 'milestone' | 'turning'
export type ComparisonFocus = { eventId?: string; articleId?: string }
export type LifeEvent = {
  id: string; title: string; date: string; facts: string; analysis: string; evidence: Evidence[]; updatedAt: string
  cause?: string; outcome?: string; dateNote?: string; outlook?: string; impact?: string; prediction?: string; chapterId?: string; followups?: Followup[]; topics?: string[]; importance?: EventImportance
}
export type Followup = { id: string; date: string; outcome: string; reflection: string }
export type Chapter = { id: string; title: string; introduction: string; order: number }
export type TurningPoint = { id: string; date: string; before: string; after: string; why: string; eventId?: string }
export type Dream = { id: string; title: string; date: string; original: string; feelings: string; associations: string; notes: { at: string; text: string }[]; updatedAt: string }
export type Article = {
  title: string; category: string; fact: string; eventIds: string[]; evidence: Evidence[]
}
export type Revision = Article & { at: string; reason: string; action: 'create' | 'edit' | 'delete' | 'restore' | 'baseline' }
export type Proposal = {
  id: string; kind: 'event' | 'article' | 'question'; title: string; content: string; basis: string; counterpoint: string;
  category: string; eventIds: string[]; articleId?: string; evidence: Evidence[]; origin: 'diary' | 'chat' | 'review'; originId?: string; chatReplyId?: string; eventDraft?: { date: string; cause: string; outcome: string };
  status: 'pending' | 'accepted' | 'dismissed' | 'corrected'; correction?: string; createdAt: string;
}
export type PersonalState = {
  events: LifeEvent[]; proposals: Proposal[]; revisions: Record<string, Revision[]>;
  diarySeen: string[]; summary: string; summaryThrough: number; focusId?: string; diaryFocusId?: string; comparisonFocus?: ComparisonFocus; chatEvidence?: Record<string, Evidence[]>;
  chapters?: Chapter[]; turningPoints?: Record<string, TurningPoint[]>; dreams?: Dream[]; dreamFocusId?: string; privateTurns?: string[]; dreamTurns?: Record<string, string>; dreamDrafts?: Record<string, { userId: string }>;
}
export const emptyPersonalState = (): PersonalState => ({ events: [], proposals: [], revisions: {}, diarySeen: [], summary: '', summaryThrough: 0 })
