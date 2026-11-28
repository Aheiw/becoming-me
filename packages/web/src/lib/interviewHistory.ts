export type InterviewSession = { id: string; type: 'regular' | 'onboarding'; status: 'active' | 'completed' | 'abandoned'; startedAt: string }
export type InterviewDiaryBatch = { id: string; filename: string | null; count: number; createdAt: string; hasAnalysis: boolean; origin: 'legacy' | 'import' | 'journal' }
export type InterviewDiary = { date: string | null; filename: string | null; content: string }
export type DiaryAnalysisItem = { category: string; fact: string; basis: string; citations: { source: number; quote: string }[] }
export type InterviewDiaryDetails = { entries: InterviewDiary[]; analysis: DiaryAnalysisItem[] | null }
export type InterviewHistory = { sessions: InterviewSession[]; diaries: InterviewDiaryBatch[] }

export async function interviewHistoryRequest<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/interview-history${path}`, init)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.error === 'string' ? data.error : '无法读取本地访谈历史，请重试。')
  }
  return response.status === 204 ? undefined as T : response.json()
}
