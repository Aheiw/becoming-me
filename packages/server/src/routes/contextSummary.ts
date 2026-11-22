import { Hono } from 'hono'
import * as schema from '../db/schema.js'
import { eq, desc, asc, sql } from 'drizzle-orm'
import type { AppVariables } from '../types.js'

const { structuredFacts, lifeTimeline, sessionVignettes, diaryFactEvidences, diaryEntries, professionalRecords } = schema

export const contextSummaryRoute = new Hono<{ Variables: AppVariables }>()

contextSummaryRoute.get('/', async (c) => {
  c.header('Cache-Control', 'no-store')
  const db = c.get('db')
  const userId = c.get('userId')
  const full = c.req.query('view') === 'encyclopedia'

  const ranked = db
    .select({
      category: structuredFacts.category,
      id: structuredFacts.id,
      fact: structuredFacts.fact,
      source: structuredFacts.source,
      createdAt: structuredFacts.createdAt,
      rn: sql<number>`row_number() over (
        partition by ${structuredFacts.category}, (${structuredFacts.source} = 'diary')
        order by ${structuredFacts.createdAt} desc
      )`.as('rn'),
    })
    .from(structuredFacts)
    .where(eq(structuredFacts.userId, userId))
    .as('ranked')

  const [facts, timeline, vignettes, professional] = await Promise.all([
    db.select({
      id: ranked.id, category: ranked.category, fact: ranked.fact,
      diary: { id: diaryEntries.id, date: diaryEntries.entryDate, filename: diaryEntries.filename, quote: diaryFactEvidences.quote },
    })
      .from(ranked)
      .leftJoin(diaryFactEvidences, eq(diaryFactEvidences.factId, ranked.id))
      .leftJoin(diaryEntries, sql`${diaryEntries.id} = ${diaryFactEvidences.diaryId} and ${diaryEntries.userId} = ${userId}`)
      .where(full ? undefined : sql`${ranked.rn} <= 2 or ${ranked.source} = 'diary'`)
      .orderBy(asc(ranked.category), desc(ranked.createdAt), asc(ranked.id), asc(diaryFactEvidences.ordinal)),
    db.select().from(lifeTimeline)
      .where(eq(lifeTimeline.userId, userId))
      .orderBy(asc(lifeTimeline.eventYear)),
    db.select().from(sessionVignettes)
      .where(eq(sessionVignettes.userId, userId))
      .orderBy(desc(sessionVignettes.createdAt))
      .limit(1),
    full ? db.select({ id: professionalRecords.id, company: professionalRecords.companyName,
      role: professionalRecords.role, description: professionalRecords.description, skills: professionalRecords.skills,
      startYear: professionalRecords.startYear, endYear: professionalRecords.endYear })
      .from(professionalRecords).where(eq(professionalRecords.userId, userId)).orderBy(desc(professionalRecords.startYear)) : [],
  ])

  const byId = new Map<string, {
    id: string; category: string; fact: string
    diaries?: { id: string; date: string | null; filename: string | null; quote: string }[]
  }>()
  for (const { id, category, fact, diary } of facts) {
    let item = byId.get(id)
    if (!item) {
      item = { id, category, fact }
      byId.set(id, item)
    }
    if (diary?.id && diary.quote) {
      (item.diaries ??= []).push({ ...diary, id: diary.id, date: diary.date, quote: diary.quote })
    }
  }

  return c.json({
    facts: [...byId.values()],
    timeline: timeline.map(t => ({
      year: t.eventYear,
      month: t.eventMonth,
      description: t.eventDescription,
    })),
    vignette: vignettes[0] ?? null,
    ...(full ? { professional } : {}),
  })
})
