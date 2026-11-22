import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import SimpleMarkdown from '../SimpleMarkdown.js'
import { interviewHistoryRequest, type InterviewDiaryDetails, type InterviewHistory } from '../../lib/interviewHistory.js'
import { api, body, Empty, EvidenceList, Page, stamp, type Data, type Evidence, type Work } from './shared.js'
import { EventDraftEditor } from './Inbox.js'
import { DreamForm } from './Dreams.js'
import styles from './Personal.module.css'

type Message = { id: string; role: 'assistant' | 'user'; content: string; createdAt: string; evidence: Evidence[]; dream?: boolean; dreamDraft?: { userId: string } }
type Update = { type: 'delta'; text: string } | { type: 'saved'; id: string; userId: string; evidence: Evidence[]; dream: boolean; dreamDraft?: Message['dreamDraft'] }
  | { type: 'progress'; phase: 'recall' | 'diary' | 'reply'; retrieval?: 'keyword' | 'hybrid' } | { type: 'error'; error: string } | { type: 'done'; count?: number; warning?: string; notice?: string }

export function Archive({ useDiary }: { useDiary: (id: string) => Promise<unknown> }) {
  const [opened, setOpened] = useState(false)
  const [index, setIndex] = useState<InterviewHistory>()
  const [contents, setContents] = useState<ReactNode>()
  const [selection, setSelection] = useState('')
  const [error, setError] = useState('')
  const requestId = useRef(0)
  useEffect(() => {
    if (!opened) return
    const controller = new AbortController()
    setError('')
    interviewHistoryRequest<InterviewHistory>('', { signal: controller.signal }).then(setIndex).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [opened])
  async function open(kind: 'sessions' | 'diaries', id: string) {
    const request = ++requestId.current
    setSelection(id); setContents('正在读取…'); setError('')
    try {
      if (kind === 'sessions') {
        const result = await interviewHistoryRequest<{ messages: { role: string; content: string }[] }>(`/sessions/${id}`)
        if (request === requestId.current) setContents(result.messages.map((m, i) => <p className={styles.preserve} key={i}><strong>{m.role === 'user' ? '我' : 'AI'}：</strong>{m.content}</p>))
      } else {
        const result = await interviewHistoryRequest<InterviewDiaryDetails>(`/diaries/${id}`)
        if (request === requestId.current) setContents(<><h4>日记及历史分析</h4>{result.analysis && <button type="button" onClick={() => void useDiary(id)}>带着这批分析继续聊天</button>}{result.analysis?.map((a, i) => <p key={i}>{a.fact}</p>)}{result.entries.map((d, i) => <details className={styles.details} key={i}><summary>{d.date ?? '日期未知'} · {d.filename ?? `第 ${i + 1} 篇`}</summary><pre className={styles.original}>{d.content}</pre></details>)}</>)
      }
    } catch (err) { if (request === requestId.current) setContents(<p role="alert">{(err as Error).message}</p>) }
  }
  return <details className={styles.details} onToggle={e => setOpened(e.currentTarget.open)}><summary>旧访谈与日记原件</summary>
    <p className={styles.muted}>这些原件保存在本机。聊天里可以按日期或主题查日记原文，只把少量相关片段发给模型。</p>
    {error && <p role="alert">{error}</p>}
    {index && <div className={styles.actions}>
      {index.sessions.filter(s => !s.id.startsWith('personal-')).map(s => <button type="button" key={s.id} disabled={selection === s.id} onClick={() => void open('sessions', s.id)}>旧访谈 · {stamp(s.startedAt)}</button>)}
      {index.diaries.map(d => <button type="button" key={d.id} disabled={selection === d.id} onClick={() => void open('diaries', d.id)}>{d.filename ?? '日记'} · {d.count} 篇 · {stamp(d.createdAt)}</button>)}
    </div>}
    {contents && <div className={styles.card}>{contents}</div>}
  </details>
}

function ChatEventCard({ proposal, data, work }: { proposal: Data['proposals'][number]; data: Data; work: Work }) {
  const [editing, setEditing] = useState(false)
  const [classify, setClassify] = useState(false)
  return <aside className={styles.chatSuggestion}><strong>把这段经历记进事件簿？</strong><p className={styles.preserve}>{proposal.title}</p>
    <EvidenceList evidence={proposal.evidence} title="核对原话" />
    {!editing && <div className={styles.actions}>
      <button type="button" onClick={() => setEditing(true)}>核对并记录</button>
      <button type="button" onClick={() => setClassify(value => !value)}>不是事件</button>
      <button type="button" onClick={() => void work(() => api('/proposals/' + proposal.id, body({ action: 'dismiss' })), '已忽略，不写入事件簿。')}>忽略</button>
    </div>}
    {!editing && classify && <div className={styles.actions}><button type="button" onClick={() => void work(() => api('/proposals/' + proposal.id, body({ action: 'classify', kind: 'article' })), '已改成百科草稿，仍在收件箱等待确认。')}>改为百科草稿</button></div>}
    {editing && <EventDraftEditor proposal={proposal} data={data} work={work} cancel={() => setEditing(false)} saved={() => setEditing(false)} />}
  </aside>
}
function ChatDreamCard({ replyId, original, work, done }: { replyId: string; original: string; work: Work; done: () => void }) {
  const [editing, setEditing] = useState(false)
  const route = '/chat/dream-drafts/' + replyId
  return <aside className={styles.chatSuggestion}><strong>把这个梦单独存到梦境簿？</strong>
    <p className={styles.muted}>这一回合留在聊天历史里，不用于普通对话记忆，也不作为现实事件或人格依据。</p>
    {editing ? <DreamForm initial={{ title: '一次梦境', date: '', original, feelings: '', associations: '' }} cancel={() => setEditing(false)} onSave={async dream => {
      if (await work(() => api(route, body({ action: 'save', dream })), '已单独保存到梦境簿。')) done()
    }} /> : <div className={styles.actions}><button type="button" onClick={() => setEditing(true)}>核对并保存</button><button type="button" onClick={async () => { if (await work(() => api(route, body({ action: 'dismiss' })), '已忽略，未记入梦境簿。')) done() }}>忽略</button></div>}
  </aside>
}
export default function LongChat({ hidden, data, work, changed, openDiary }: { hidden: boolean; data?: Data; work: Work; changed: () => Promise<unknown>; openDiary: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [searchDiary, setSearchDiary] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const current = useRef('')
  const request = useRef<AbortController | null>(null)
  const activeProposal = data?.proposals.find(p => p.id === data.focusId)
  const activeDream = data?.dreams.find(d => d.id === data.dreamFocusId)
  const comparedArticle = data?.articles.find(a => !a.deleted && a.id === data.comparisonFocus?.articleId)
  const comparedEvent = data?.events.find(e => e.id === data.comparisonFocus?.eventId && (!data.comparisonFocus?.articleId || comparedArticle?.eventIds.includes(e.id)))
  const comparisonTitles = [comparedEvent?.title, comparedArticle?.title].filter(Boolean).join(' / ')
  const comparisonPrompt = '请对照我选的资料：当时的我怎么说？与现在的理解有什么不同？有哪些反例或缺失的证据？没有足够依据就直说。'
  const drafts = new Map<string, Data['proposals']>()
  for (const p of data?.proposals ?? []) if (p.chatReplyId && p.kind === 'event' && p.status === 'pending') {
    const items = drafts.get(p.chatReplyId) ?? []
    items.push(p); drafts.set(p.chatReplyId, items)
  }
  const originals = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message.content]))
  async function load(signal?: AbortSignal) {
    try { setMessages((await api<{ messages: Message[] }>('/chat', { signal })).messages); setLoaded(true); setError('') }
    catch (err) { if (!signal?.aborted) setError((err as Error).message) }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => { controller.abort(); request.current?.abort() } }, [])
  useEffect(() => { if (!hidden) bottom.current?.scrollIntoView({ block: 'nearest' }) }, [messages, hidden])
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = input.trim()
    if (pendingRef.current || !loaded || !message) return
    const id = crypto.randomUUID(), assistant = `${id}-answer`, at = new Date().toISOString()
    const controller = new AbortController()
    current.current = id; request.current = controller; pendingRef.current = true; setPending(true); setInput(''); setSearchDiary(false); setError(''); setProgress('正在查找相关往事…')
    setMessages(old => [...old, { id, role: 'user', content: message, createdAt: at, evidence: [], dream: Boolean(activeDream) }, { id: assistant, role: 'assistant', content: '', createdAt: at, evidence: [], dream: Boolean(activeDream) }])
    let saved = false
    function handle(event: Update) {
      if (event.type === 'delta') setMessages(old => old.map(m => m.id === assistant ? { ...m, content: m.content + event.text } : m))
      if (event.type === 'progress' && current.current === id) setProgress(event.phase === 'diary' ? '正在本地查找日记原文…' : event.phase === 'recall' ? '正在查找相关往事…' : '正在回复…')
      if (event.type === 'saved') {
        saved = true
        setMessages(old => old.map(m => m.id === assistant ? { ...m, id: event.id, evidence: event.evidence, dream: event.dream, dreamDraft: event.dreamDraft } : m.id === id ? { ...m, id: event.userId, dream: event.dream } : m))
        if (current.current === id) { setProgress(event.dream ? '' : '回复已保存，正在整理待核对的建议…') }
      }
      if (event.type === 'done') {
        if (current.current === id) setProgress(event.warning ?? event.notice ?? (event.count ? `已放入 ${event.count} 条待核对建议。` : ''))
        void changed().catch(() => {})
      }
      if (event.type === 'error') throw new Error(event.error)
    }
    try {
      const res = await fetch('/api/personal/chat', { ...body({ message, searchDiary }), signal: controller.signal })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '请求失败，请重试。')
      if (!res.body) throw new Error('本次回复未收到。')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (line) handle(JSON.parse(line) as Update)
          }
        }
        if (!saved) throw new Error('连接中断，未确认回复是否保存；可以刷新对话确认。')
        if (current.current === id) setProgress(previous => previous === '回复已保存，正在整理待核对的建议…' ? '' : previous)
      } finally { await reader.cancel().catch(() => {}) }
    } catch (err) {
      if (!saved) { setMessages(old => old.filter(m => m.id !== id && m.id !== assistant)); setInput(value => value || message) }
      if (current.current === id && !controller.signal.aborted) { setProgress(''); setError((err as Error).message) }
    } finally {
      if (current.current === id) { pendingRef.current = false; setPending(false); request.current = null }
    }
  }
  return <div hidden={hidden}><Page kicker="同一个对话" title="长期对话" hint="随时接着聊。回想起旧事时，AI 会查相关资料；你可以纠正它的理解。" actions={<button type="button" onClick={openDiary}>分析日记</button>}>
    {data?.comparisonFocus && <div className={styles.banner}><span>{comparisonTitles ? '已带入对照：' + comparisonTitles : '选中的对照资料已变更或移除。'}</span><div className={styles.actions}>
      {comparisonTitles && <button type="button" disabled={pending || !!input.trim()} onClick={() => setInput(comparisonPrompt)}>填入对照问题</button>}
      <button type="button" onClick={() => void work(() => api('/focus', body({ comparison: null })))}>退出对照</button>
    </div></div>}
    {activeProposal && <div className={styles.banner}><span>正在核对：{activeProposal.title}</span><button type="button" onClick={() => void work(() => api('/focus', body({ id: null })))}>退出此话题</button></div>}
    {data?.diaryFocusId && <div className={styles.banner}><span>这次对话带着已选日记批次的综合分析。查日记原文时默认查这批，也可以指定全部日记。</span><button type="button" onClick={() => void work(() => api('/focus', body({ clearDiary: true })))}>停止带入</button></div>}
    {activeDream && <div className={styles.banner}><span>仅在这段讨论中带入梦境：{activeDream.title}</span><button type="button" onClick={() => void work(() => api('/focus', body({ dreamId: null })))}>结束梦境讨论</button></div>}
    {error && <p role="alert" className={styles.error}>{error} {!loaded && <button type="button" onClick={() => void load()}>重试</button>}</p>}
    {!messages.length && <Empty>{loaded ? '可以从最近一件值得记的事，或你一直想弄懂的选择聊起。' : '正在读取长期对话…'}</Empty>}
    <div className={styles.conversation}>
      {messages.filter(m => m.content).map(m => <article className={m.role === 'user' ? styles.userMessage : styles.assistantMessage} key={m.id}>
        <small>{m.role === 'user' ? '我' : 'AI 分析搭档'}{m.dream && ' · 梦境讨论'} · {stamp(m.createdAt)}</small>
        {m.role === 'assistant' ? <SimpleMarkdown>{m.content}</SimpleMarkdown> : <p className={styles.preserve}>{m.content}</p>}
        <EvidenceList evidence={m.evidence} title="本轮参考的原话" />
        {data && drafts.get(m.id)?.map(p => <ChatEventCard key={p.id} proposal={p} data={data} work={work} />)}
        {m.dreamDraft && <ChatDreamCard replyId={m.id} original={originals.get(m.dreamDraft.userId) ?? ''} work={work} done={() => setMessages(old => old.map(item => item.id === m.id ? { ...item, dreamDraft: undefined } : item))} />}
      </article>)}
      <div ref={bottom} />
    </div>
    <form onSubmit={send} className={styles.composer}>
      {progress && <p role="status">{progress}</p>}
      <label className={styles.field}><span>给分析搭档留言</span><textarea value={input} onChange={e => setInput(e.target.value)} maxLength={24000} rows={3} placeholder="最近有件事，我想重新看看……" /></label>
      <label className={styles.archiveToggle}><input type="checkbox" checked={searchDiary} onChange={e => setSearchDiary(e.target.checked)} disabled={pending || Boolean(activeDream)} />本轮查日记原文</label>
      <div className={styles.actions}><button className={styles.primary} disabled={pending || !loaded || !input.trim()}>发送</button><small>发送会把本轮对话和选中的少量相关资料交给已配置的聊天 API。</small></div>
    </form>
    <Archive useDiary={diaryId => work(() => api('/focus', body({ diaryId })), '已带入这批历史分析，不会重新发送全部原文。')} />
  </Page></div>
}
