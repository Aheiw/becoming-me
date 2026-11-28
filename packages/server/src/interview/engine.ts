import { eq, and, asc, sql } from 'drizzle-orm'
import { DEFAULT_USER_ID, getUserLanguage } from '../db/client.js'
import type { Db } from '../types.js'
import { sessions, users, rawLogs, questions, questionTranslations, userQuestions } from '../db/schema.js'
import { generateInterviewResponse, transformToCoachingTone } from '../llm/provider.js'
import { selectNextQuestion, getExistingFactsSummary } from './questionSelector.js'
import {
  buildSystemPrompt, buildOnboardingSystemPrompt,
  MAX_FOLLOWUPS_PER_QUESTION, MAX_QUESTIONS_PER_SESSION,
} from './prompts.js'
import { extractAndSaveFacts, buildSessionSummary } from './factExtractor.js'
import { getInterviewSources, interviewHistoryInstruction, interviewHistoryMessage } from './history.js'

export { startSession, startOnboarding, endSession, skipQuestion } from './sessionManager.js'
export { buildSessionSummary } from './factExtractor.js'
export type { SessionSummary } from './factExtractor.js'

export async function processMessage(
  db: Db,
  sessionId: string,
  userId = DEFAULT_USER_ID,
  userMessage: string,
  languageOverride?: string,
) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
  if (!session || session.status !== 'active' || session.userId !== userId) {
    throw new Error('Session not found or already ended')
  }

  const useHistory = process.env.BECOMING_ME_LOCAL === '1' && session.type === 'regular'
  const language = languageOverride ?? await getUserLanguage(db, userId)

  const userLog = { id: crypto.randomUUID(), userId, sessionId, role: 'user' as const, content: userMessage }
  if (!useHistory) await db.insert(rawLogs).values(userLog)

  const history = await db
    .select()
    .from(rawLogs)
    .where(and(eq(rawLogs.sessionId, sessionId), eq(rawLogs.userId, userId)))
    .orderBy(asc(rawLogs.createdAt), asc(rawLogs.id))

  let currentQuestionText: string | null = null
  if (session.currentQuestionId) {
    const [row] = await db
      .select({
        content: sql<string>`COALESCE(${questionTranslations.content}, ${questions.content})`,
      })
      .from(questions)
      .leftJoin(
        questionTranslations,
        and(
          eq(questionTranslations.questionId, questions.id),
          eq(questionTranslations.language, language),
        ),
      )
      .where(eq(questions.id, session.currentQuestionId))
    currentQuestionText = row?.content ?? null
  }

  const existingFacts = await getExistingFactsSummary(db, userId, language)

  const systemPrompt = session.type === 'onboarding'
    ? buildOnboardingSystemPrompt(session.followupCount, language)
    : buildSystemPrompt(
        session.questionsAsked,
        session.followupCount,
        currentQuestionText,
        existingFacts,
        language,
      )

  const earlier = useHistory ? interviewHistoryMessage(await getInterviewSources(db, userId, sessionId)) : null
  const current = (useHistory ? [...history, userLog] : history)
    .filter(log => log.role !== 'system')
    .map(log => ({ role: log.role as 'user' | 'assistant', content: log.content }))
  const { response, askedFollowup: rawAskedFollowup, shouldEndSession } = await generateInterviewResponse(
    useHistory ? `${systemPrompt}\n\n${interviewHistoryInstruction}` : systemPrompt,
    earlier ? [earlier, ...current] : current,
    useHistory,
  )

  // Server-side enforcement: ignore AI's askedFollowup when the limit is already reached
  const askedFollowup =
    session.type !== 'onboarding' && session.followupCount >= MAX_FOLLOWUPS_PER_QUESTION
      ? false
      : rawAskedFollowup

  // When moving to the next question, append it to the response so the user
  // sees the actual question rather than just a transition phrase.
  let finalResponse = response
  let nextQuestion: { id: string; content: string } | null = null

  if (!shouldEndSession && !askedFollowup) {
    nextQuestion = await selectNextQuestion(db, userId, language)
    if (nextQuestion) {
      const nextMsg = await transformToCoachingTone(nextQuestion.content, existingFacts, language)
      finalResponse = response + '\n\n' + nextMsg
    }
  }

  const assistantLog = { id: crypto.randomUUID(), userId, sessionId, role: 'assistant' as const, content: finalResponse }
  if (useHistory) {
    // A rejected model request must not leave an unanswered turn in history.
    const at = Date.now()
    await db.insert(rawLogs).values([
      { ...userLog, createdAt: new Date(at - 1) }, { ...assistantLog, createdAt: new Date(at) },
    ])
  } else {
    await db.insert(rawLogs).values(assistantLog)
  }

  if (shouldEndSession) {
    await db.transaction(async (tx) => {
      await tx.update(sessions)
        .set({ status: 'completed', endedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(sessions.id, sessionId))

      if (session.type === 'onboarding') {
        await tx.update(users)
          .set({ onboardingCompletedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(users.id, userId))
      }

      if (session.currentQuestionId) {
        await tx.insert(userQuestions).values({ userId, questionId: session.currentQuestionId }).onConflictDoNothing()
      }
    })

    const conversationText = (useHistory ? [...history, userLog] : history).map(l => `[${l.role}]: ${l.content}`).join('\n\n')
    try {
      await extractAndSaveFacts(db, sessionId, userId, conversationText, language)
    } catch (err) {
      console.error('Failed to extract facts from conversation:', err)
    }

    const summary = await buildSessionSummary(db, sessionId).catch(() => ({ facts: {}, timeline: 0, vignettes: [] as string[] }))
    return { response: finalResponse, shouldEnd: true, remainingTurns: 0, summary }
  } else if (!askedFollowup) {
    if (session.currentQuestionId) {
      await db.insert(userQuestions).values({ userId, questionId: session.currentQuestionId }).onConflictDoNothing()
    }
    await db.update(sessions)
      .set({
        questionsAsked: session.questionsAsked + 1,
        followupCount: 0,
        currentQuestionId: nextQuestion?.id ?? null,
      })
      .where(eq(sessions.id, sessionId))
  } else {
    await db.update(sessions)
      .set({ followupCount: session.followupCount + 1 })
      .where(eq(sessions.id, sessionId))
  }

  const remainingTurns = session.type === 'onboarding'
    ? null
    : MAX_QUESTIONS_PER_SESSION - (askedFollowup ? session.questionsAsked : session.questionsAsked + 1)

  return { response: finalResponse, shouldEnd: shouldEndSession, remainingTurns }
}
