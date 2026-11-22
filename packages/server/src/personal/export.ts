import { eventImportance, importanceLabel, turningEvents } from './reading.js'
import JSZip from 'jszip'
import { articleHistory, readArticles } from './store.js'
import type { Db } from '../types.js'
import type { Evidence, LifeEvent, PersonalState } from './types.js'

const heading = (s: string) => s.replace(/[\r\n]/g, ' ')
const section = (name: string, body?: string) => body ? `\n## ${name}\n\n${body}\n` : ''
const sources = (entries: Evidence[]) => entries.map(e => `${e.date ?? '时间未知'} · ${e.label ?? (e.kind === 'chat' ? '对话原话' : '日记原话')}\n${e.quote.split('\n').map(line => `> ${line}`).join('\n')}`).join('\n\n')
const sortDate = (a: LifeEvent, b: LifeEvent) => (a.date || '9999').localeCompare(b.date || '9999') || a.updatedAt.localeCompare(b.updatedAt)
const link = (label: string, path: string) => `[${heading(label).replace(/[\[\]\\]/g, '\\$&')}](${path})`

export async function exportPersonalBook(db: Db, userId: string, state: PersonalState, dreamsOnly: boolean) {
  const zip = new JSZip()
  if (dreamsOnly) {
    const dreams = [...(state.dreams ?? [])].sort((a, b) => b.date.localeCompare(a.date))
    zip.file('README.md', '# 梦境簿\n\n独立梦境档案。AI 联想不是现实事实或性格判断。\n\n' + dreams.map(d => `- ${d.date} ${link(d.title, `dreams/${d.id}.md`)}`).join('\n'))
    for (const d of dreams) zip.file(`dreams/${d.id}.md`, `# ${heading(d.title)}\n\n${d.date}\n${section('梦境原文', d.original)}${section('醒来时的感受', d.feelings)}${section('我的联想', d.associations)}${d.notes.map(n => section(`AI 联想（${n.at.slice(0, 10)}）`, n.text)).join('')}`)
  } else {
    const articles = await readArticles(db, userId, state)
    const events = [...state.events].sort(sortDate)
    const chapters = [...(state.chapters ?? [])].sort((a, b) => a.order - b.order)
    const byId = new Map(events.map(e => [e.id, e]))
    const turnsByEvent = turningEvents(state.turningPoints ?? {})
    const eLink = (e: LifeEvent, prefix = '') => `- ${e.dateNote || e.date || '时间未定'} ${link(e.title, `${prefix}events/${e.id}.md`)}`
    zip.file('README.md', `# 我的人生书\n\n以时间线读经历，以百科浏览主题。私密梦境不包含在此卷。\n${section('人生章节', chapters.map(ch => `- ${link(ch.title, `chapters/${ch.id}.md`)}`).join('\n'))}${section('大事和转折', events.filter(e => eventImportance(e, turnsByEvent) !== 'regular').map(e => eLink(e)).join('\n'))}${section('完整时间线', events.map(e => eLink(e)).join('\n') || '还没有事件。')}${section('百科条目', articles.filter(a => !a.deleted).map(a => `- ${link(a.title, `articles/${a.id}.md`)}`).join('\n') || '还没有已确认条目。')}${section('已删除的条目（仅保留版本）', articles.filter(a => a.deleted).map(a => `- ${link(a.title, `articles/${a.id}.md`)}`).join('\n'))}`)
    for (const ch of chapters) zip.file(`chapters/${ch.id}.md`, `# ${heading(ch.title)}\n\n${ch.introduction}\n${section('本章事件', events.filter(e => e.chapterId === ch.id).map(e => eLink(e, '../')).join('\n'))}`)
    for (const e of events) {
      const related = articles.filter(a => !a.deleted && a.eventIds.includes(e.id)).map(a => `- ${link(a.title, `../articles/${a.id}.md`)}`).join('\n')
      zip.file(`events/${e.id}.md`, `# ${heading(e.title)}\n\n${e.dateNote || e.date || '时间未定'}\n${section('事件标记', importanceLabel[eventImportance(e, turnsByEvent)])}${section('事件主题', e.topics?.join('、'))}${section('起因', e.cause)}${section('经过', e.facts)}${section('实际结果', e.outcome)}${section('当时怎么看', e.outlook)}${section('当时的预期', e.prediction)}${section('后来的影响', e.impact)}${section('可能体现什么（待核对）', e.analysis)}${section('原话', sources(e.evidence))}${section('相关百科', related)}${e.followups?.map(f => section(`回访 ${f.date}`, f.outcome + (f.reflection ? `\n\n事后看法：${f.reflection}` : ''))).join('') ?? ''}`)
    }
    for (const a of articles) {
      const versions = await articleHistory(db, userId, state, a.id)
      const turns = (state.turningPoints?.[a.id] ?? []).slice().sort((x, y) => x.date.localeCompare(y.date))
      const related = a.eventIds.map(id => byId.get(id)).filter((e): e is LifeEvent => !!e).map(e => eLink(e, '../')).join('\n')
      zip.file(`articles/${a.id}.md`, `# ${heading(a.title)}\n\n${a.deleted ? '（已移入回收站）\n\n' : ''}${a.fact}\n${section('主题', a.category)}${section('相关事件', related)}${section('观点演变', turns.map(t => {
        const e = t.eventId ? byId.get(t.eventId) : undefined
        return `### ${t.date || '时间未定'}\n\n之前：${t.before}\n\n后来：${t.after}\n\n为什么变化：${t.why}${e ? `\n\n${eLink(e, '../')}` : ''}`
      }).join('\n\n'))}${section('修订历史', versions.map((v, i) => `### 第 ${i + 1} 版 · ${v.at}\n\n原因：${v.reason}\n\n**${heading(v.title)}**\n\n${v.fact}\n\n${sources(v.evidence)}`).join('\n\n'))}`)
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
