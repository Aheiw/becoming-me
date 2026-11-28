import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import * as dbSchema from '../db/schema.js'
import type { Db } from '../types.js'

// Order follows foreign keys. The three evidence tables inherit ownership from their parents.
const tables: readonly PgTable[] = [dbSchema.users, dbSchema.sessions, dbSchema.rawLogs,
  dbSchema.userQuestions, dbSchema.structuredFacts, dbSchema.diaryEntries, dbSchema.diarySavedBatches,
  dbSchema.interviewDiaryBatches, dbSchema.lifeTimeline, dbSchema.professionalRecords,
  dbSchema.sessionVignettes, dbSchema.sessionQuota, dbSchema.personalWorkspaces, dbSchema.personalVectors,
  dbSchema.factEvidences, dbSchema.diaryFactEvidences, dbSchema.timelineEvidences]
const edgeParents = {
  fact_evidences: [['fact_id', 'structured_facts'], ['log_id', 'raw_logs']],
  diary_fact_evidences: [['fact_id', 'structured_facts'], ['diary_id', 'diary_entries']],
  timeline_evidences: [['timeline_id', 'life_timeline'], ['log_id', 'raw_logs']],
} as Record<string, [string, string][] | undefined>
const backupName = /^becoming-me-(manual|before-clear|before-restore)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[a-f0-9]{8}\.json$/
const folder = () => resolve('data', 'backups')
type Reason = 'manual' | 'before-clear' | 'before-restore'
type Row = Record<string, unknown>
type Snapshot = { format: 'becoming-me/records'; version: 1; createdAt: string; records: Record<string, Row[]> }
export class InvalidBackup extends Error {}

async function snapshot(db: Db, userId: string): Promise<Snapshot> {
  return db.transaction(async tx => {
    const records: Snapshot['records'] = {}
    for (const table of tables) {
      const name = getTableName(table)
      const edges = edgeParents[name]
      const ownership = edges ? sql.join(edges.map(([field, parent]) =>
        sql`row.${sql.identifier(field)} IN (SELECT id FROM ${sql.identifier(parent)} WHERE user_id = ${userId})`), sql` AND `)
        : sql`row.${sql.identifier(name === 'users' ? 'id' : 'user_id')} = ${userId}`
      const rows = await tx.execute<{ data: Row }>(sql`SELECT to_jsonb(row) AS data FROM ${sql.identifier(name)} AS row WHERE ${ownership}`)
      records[name] = rows.map(r => r.data)
    }
    return { format: 'becoming-me/records', version: 1, createdAt: new Date().toISOString(), records }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function createBackup(db: Db, userId: string, reason: Reason) {
  const data = await snapshot(db, userId)
  const name = `becoming-me-${reason}-${data.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`
  await mkdir(folder(), { recursive: true, mode: 0o700 })
  const path = join(folder(), name), temp = `${path}.tmp`
  try {
    await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }).catch(() => {}) }
  return { name, path, createdAt: data.createdAt, reason }
}

export async function listBackups() {
  const entries = await readdir(folder(), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
    return []
  })
  const backups = entries.flatMap(entry => {
    const match = entry.isFile() && backupName.exec(entry.name)
    if (!match) return []
    const [date, time] = match[2].split('T'), [h, m, s, ms] = time.split('-')
    return [{ name: entry.name, reason: match[1], createdAt: `${date}T${h}:${m}:${s}.${ms}` }]
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name))
  return { folder: folder(), backups }
}

export async function readBackup(name: string, userId: string): Promise<Snapshot> {
  if (!backupName.test(name) || !(await listBackups()).backups.some(entry => entry.name === name)) throw new InvalidBackup('找不到所选的成我备份。')
  let data: Snapshot
  try { data = JSON.parse(await readFile(join(folder(), name), 'utf8')) }
  catch { throw new InvalidBackup('无法读取此备份文件。') }
  const incompatible = () => new InvalidBackup('备份的版本或内容不兼容，未更改现有记录。')
  if (data?.format !== 'becoming-me/records' || data.version !== 1 || !data.records || Object.keys(data.records).length !== tables.length) throw incompatible()
  const ids = new Map<string, Set<unknown>>()
  for (const table of tables) {
    const name = getTableName(table), rows = data.records[name], edges = edgeParents[name]
    const columns = Object.values(getTableColumns(table)).map(col => col.name)
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Object.keys(row).length !== columns.length
      || !columns.every(c => Object.hasOwn(row, c)) || (edges
        ? !edges.every(([field, parent]) => ids.get(parent)?.has(row[field]))
        : row[name === 'users' ? 'id' : 'user_id'] !== userId))) throw incompatible()
    ids.set(name, new Set(rows.map(row => row.id)))
  }
  if (data.records.users.length !== 1) throw incompatible()
  return data
}

export async function replaceRecords(db: Db, userId: string, backup?: Snapshot) {
  await db.transaction(async tx => {
    // All user-owned tables cascade, including both chat stores, evidence and vectors.
    await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`)
    if (!backup) {
      await tx.insert(dbSchema.users).values({ id: userId, language: 'zh', name: 'Local User', userType: 'free' })
      return
    }
    for (const table of tables) {
      const name = getTableName(table), ref = sql.identifier(name), rows = backup.records[name]
      // Populate native PostgreSQL types (timestamps, JSON data, and vector arrays).
      for (let offset = 0; offset < rows.length; offset += 200) {
        await tx.execute(sql`INSERT INTO ${ref} SELECT * FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(rows.slice(offset, offset + 200))}::jsonb)`)
      }
    }
  })
}
