import { z } from 'zod'
import { profileThemes, type ProfileFinding, type ProfileReport } from './profileTypes.js'
import type { Evidence, PersonalState } from './types.js'

export const profileDraftSchema = z.object({
  targetId: z.string().max(80).nullable(), theme: z.enum(profileThemes),
  kind: z.enum(['self', 'observation', 'correct', 'withdraw']),
  limits: z.string().max(400), question: z.string().max(400),
})
export const chatProfileSchema = profileDraftSchema.extend({
  title: z.string().max(160), observation: z.string().max(800),
  reason: z.string().max(350), quote: z.string().max(600),
})
export type ProfileDraft = z.infer<typeof profileDraftSchema> & {
  title: string; observation: string; reason: string; evidence: Evidence[];
}
export const profileRules = `画像是关于本人可复用的理解，不是事件摘要。仅当本人明确表达偏好、价值观、自我看法、边界，或给出足以形成有适用条件的观察、反例时才记录。不要用提问、假设、寒暄、梦、助手的文字或一次孤立行为给人定性；单个经历只有本人明确说明时才记录为 self，其他推断应有本人反思或多段独立依据。self 只转述本人明确说过的观点；observation 是 AI 的待验证解释，写清条件和反例，不打分、不诊断。关注价值观与偏好、决策、关系、环境和优势，大五仅为可选角度，不为凑齐维度出题。question 仅在有具体的依据且有重要分歧时填写，结合实际经历问一个开放问题；否则留空。优先给已有同主题同判断填写 targetId，不能凭空写 ID；全新发现才填 null。`

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')
const evidenceKey = (e: Evidence) => JSON.stringify([e.kind, e.id, e.index, e.quote])
export function profileContext(state: PersonalState, focused?: string, query = '') {
  const findings = state.profileReport?.findings ?? []
  const terms = query.match(/[\u3400-\u9fff]+|[a-z]{3,}/gi)?.flatMap(term => term.length > 2 && /[\u3400-\u9fff]/.test(term) ? Array.from(term).slice(1).map((ch, i) => term[i] + ch) : [term]) ?? []
  const score = (f: ProfileFinding) => Number(f.id === focused) * 10000 + terms.filter(t => `${f.title} ${f.observation}`.includes(t)).length * 10 + Number(f.status === 'self' || f.status === 'withdrawn')
  return [...findings].sort((a, b) => score(b) - score(a) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 16).map(f => ({
    id: f.id, theme: f.theme, title: f.title, observation: f.observation.slice(0, 500), limits: f.limits.slice(0, 240),
    status: f.status ?? 'observation', updatedAt: f.updatedAt,
  }))
}

export function applyProfileDrafts(state: PersonalState, drafts: ProfileDraft[], options: {
  origin: 'chat' | 'diary'; at: string; visible: ReturnType<typeof profileContext>;
}) {
  let changed = 0
  const prior = new Map(options.visible.map(f => [f.id, f.updatedAt]))
  for (const d of drafts) {
    const correction = d.kind === 'correct' || d.kind === 'withdraw'
    if (!d.evidence.length || !d.title.trim() || !d.observation.trim() || (correction && (options.origin !== 'chat' || !d.targetId))) continue
    if (d.kind === 'observation' && !d.limits.trim()) continue
    const report = state.profileReport
    const matchingTitle = report?.findings.find(f => f.theme === d.theme && norm(f.title) === norm(d.title))
    const current = d.targetId ? report?.findings.find(f => f.id === d.targetId) : matchingTitle
    // Do not apply a stale edit after another turn, an import, or a deletion changed its target.
    if (d.targetId && (!current || !prior.has(d.targetId) || prior.get(d.targetId) !== current.updatedAt)) continue
    if (!d.targetId && matchingTitle && (!prior.has(matchingTitle.id) || prior.get(matchingTitle.id) !== matchingTitle.updatedAt)) continue
    const status = d.kind === 'withdraw' ? 'withdrawn' : d.kind === 'self' || d.kind === 'correct' ? 'self' : 'observation'
    if (current && ((current.status === 'self' && status === 'observation') || (current.status === 'withdrawn' && !correction))) continue
    if (current?.status === 'self' && options.origin === 'diary') continue
    const evidence = [...new Map([...d.evidence, ...(correction ? [] : current?.evidence ?? [])].map(e => [evidenceKey(e), e])).values()].slice(0, 8)
    const title = d.title.trim(), observation = d.observation.trim(), limits = d.limits.trim(), question = d.kind === 'withdraw' ? '' : d.question.trim()
    const wordingChanged = !current || current.title !== title || current.observation !== observation || current.limits !== limits || (current.status ?? 'observation') !== status
    if (current && !wordingChanged && question === current.question && evidence.every(e => current.evidence.some(p => evidenceKey(p) === evidenceKey(e)))) continue
    const reason = d.reason.trim() || (correction ? '根据本人在对话里的纠正修订。' : '补充了新的原话和依据。')
    const history = current && wordingChanged ? [...(current.history ?? []), {
      at: current.updatedAt ?? report!.updatedAt ?? report!.createdAt, title: current.title, observation: current.observation,
      limits: current.limits, status: current.status ?? 'observation', reason, evidence: current.evidence,
    }] : current?.history
    const finding: ProfileFinding = { id: current?.id ?? globalThis.crypto.randomUUID(), theme: current?.theme ?? d.theme, title, observation, limits,
      question, status, updatedAt: options.at, revisionReason: current && !wordingChanged ? current.revisionReason : reason,
      evidence, sources: current?.sources ?? [], ...(history && { history }) }
    const next: ProfileReport = state.profileReport ??= { id: globalThis.crypto.randomUUID(), createdAt: options.at, method: 'evidence-big-five', findings: [],
      coverage: { events: 0, articles: 0, contexts: 0, chats: 0, diaries: 0, usedDiary: false, from: null, to: null } }
    if (current) next.findings[next.findings.indexOf(current)] = finding
    else next.findings.push(finding)
    next.updatedAt = options.at
    for (const p of state.proposals) if (p.originId === `profile:${next.id}:${finding.id}`) {
      p.title = finding.title; p.basis = finding.observation; p.counterpoint = finding.limits; p.evidence = finding.evidence
      p.content = finding.question || '你怎么看这条理解？有没有还需要补充或改正的地方？'
    }
    changed++
  }
  return changed
}
