import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { changeState, getState, now, WorkspaceError } from '../personal/store.js'
import type { AppVariables } from '../types.js'

export const profileRoute = new Hono<{ Variables: AppVariables }>()
profileRoute.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: '请求过大。' }, 413) }))
profileRoute.onError((e, c) => e instanceof WorkspaceError ? c.json({ error: e.message }, e.status) : c.json({ error: '个人画像操作未完成，请重试。' }, 500))
profileRoute.get('/', async c => {
  const { profileReport } = await getState(c.get('db'), c.get('userId'))
  return c.json({ report: profileReport ?? null })
})
profileRoute.post('/discuss', async c => {
  const parsed = z.object({ reportId: z.string().uuid(), findingId: z.string().min(1).max(80) }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: '请选择要讨论的判断。' }, 400)
  const { reportId, findingId } = parsed.data
  return c.json(await changeState(c.get('db'), c.get('userId'), s => {
    const finding = s.profileReport?.id === reportId && s.profileReport.findings.find(f => f.id === findingId)
    if (!finding) throw new WorkspaceError('这份画像已更新，请刷新后再聊。', 404)
    const originId = `profile:${reportId}:${findingId}`
    let p = s.proposals.find(p => p.origin === 'review' && p.originId === originId)
    if (!p) {
      p = { id: randomUUID(), kind: 'question', title: finding.title, content: finding.question || '你怎么看这条理解？有没有还需要补充或改正的地方？', basis: finding.observation, counterpoint: finding.limits,
        category: 'character', eventIds: finding.sources.filter(s => s.kind === 'event').map(s => s.id),
        articleId: finding.sources.find(s => s.kind === 'article')?.id, evidence: finding.evidence,
        origin: 'review', originId, status: 'pending', createdAt: now() }
      s.proposals.push(p)
    }
    s.focusId = p.id; delete s.dreamFocusId; delete s.diaryFocusId; delete s.comparisonFocus
    return { id: p.id, question: p.content }
  }))
})
