import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import SimpleMarkdown from '../SimpleMarkdown.js'
import { interviewHistoryRequest, type InterviewDiaryDetails, type InterviewHistory } from '../../lib/interviewHistory.js'
import { api, body, Empty, EvidenceList, Page, stamp, type Data, type Evidence, type Work } from './shared.js'
import { ProposalCard } from './Inbox.js'
import { DreamForm } from './Dreams.js'
import styles from './Personal.module.css'

type ChatMode = 'chat' | 'event' | 'dream'
type ProfileTurnUpdate = { id: string; title: string; status: 'self' | 'observation' | 'withdrawn'; observation: string; limits: string; reason: string }
type TurnFeedback = { profileUpdates?: ProfileTurnUpdate[]; correctedFocus?: { title: string; correction: string } }
type Message = { id: string; role: 'assistant' | 'user'; content: string; createdAt: string; evidence: Evidence[]; dream?: boolean; dreamDraft?: { userId: string } }
type Update = { type: 'delta'; text: string } | { type: 'saved'; id: string; userId: string; evidence: Evidence[]; dream: boolean; dreamDraft?: Message['dreamDraft'] }
  | { type: 'progress'; phase: 'recall' | 'diary' | 'chat-history' | 'memory' | 'reply'; retrieval?: 'keyword' | 'hybrid' } | { type: 'error'; error: string }
  | { type: 'done'; count?: number; profileChanged?: number; profileUpdates?: ProfileTurnUpdate[]; correctedFocus?: { title: string; correction: string }; warning?: string; notice?: string }

const profileStatusLabel: Record<ProfileTurnUpdate['status'], string> = { self: '我的自述', observation: 'AI 待验证观察', withdrawn: '已撤回' }

function CitedReply({ message }: { message: Message }) {
  const [requested, setRequested] = useState<{ id: string }>()
  const refs = new Set(message.evidence.filter(source => source.kind === 'chat').map(source => source.label))
  return <>
    <SimpleMarkdown cite={id => refs.has(id) ? <button type="button" className={styles.link} onClick={() => setRequested({ id })}>{id}</button> : null}>{message.content}</SimpleMarkdown>
    <EvidenceList evidence={message.evidence} title="本轮参考的原话" requested={requested} />
  </>
}

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

function ChatDreamCard({ replyId, original, work }: { replyId: string; original: string; work: Work }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const inFlight = useRef(false)
  const draft = { title: '一次梦境', date: '', original, feelings: '', associations: '' }
  async function finish(dream?: typeof draft) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try {
      const message = dream ? '已单独保存到梦境簿。' : '已忽略，未记入梦境簿。'
      if (await work(() => api('/chat/dream-drafts/' + replyId, body(dream ? { action: 'save', dream } : { action: 'dismiss' })), message)) setStatus(message)
    } finally { setBusy(false); inFlight.current = false }
  }
  if (status) return <aside className={styles.chatSuggestion} role="status">{status}</aside>
  return <aside className={styles.chatSuggestion}><strong>把这个梦单独存到梦境簿？</strong>
    <p className={styles.muted}>这一回合留在聊天历史里，不用于普通对话记忆，也不作为现实事件或人格依据。</p>
    {editing ? <DreamForm initial={draft} cancel={() => setEditing(false)} onSave={finish} /> : <div className={styles.actions}>
      <button className={styles.primary} type="button" disabled={busy || !original.trim() || original.trim().length > 24000} onClick={() => void finish(draft)}>{busy ? '正在处理…' : '确认保存梦境'}</button>
      <button type="button" disabled={busy} onClick={() => setEditing(true)}>编辑后保存</button>
      <button type="button" disabled={busy} onClick={() => void finish()}>忽略</button>
    </div>}
  </aside>
}

export default function LongChat({ allowDiary, setAllowDiary, hidden, data, work, changed, openDiary, openEvent, openArticle, openProfile }: { allowDiary: boolean; setAllowDiary: (value: boolean) => void; hidden: boolean; data?: Data; work: Work; changed: () => Promise<unknown>; openDiary: () => void; openEvent: (id: string) => void; openArticle: (id: string) => void; openProfile: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [modeChoice, setModeChoice] = useState<{ dreamId?: string; mode: ChatMode }>()
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [turnFeedback, setTurnFeedback] = useState<Record<string, TurnFeedback>>({})
  const [skippedLeads, setSkippedLeads] = useState<string[]>([])
  const bottom = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)
  const current = useRef('')
  const request = useRef<AbortController | null>(null)
  const activeProposal = data?.proposals.find(p => p.id === data.focusId)
  const profileFocus = activeProposal?.originId?.startsWith('profile:') ? activeProposal : undefined
  const activeDream = data?.dreams.find(d => d.id === data.dreamFocusId)
  const mode = profileFocus ? 'chat' : modeChoice && modeChoice.dreamId === activeDream?.id ? modeChoice.mode : activeDream ? 'dream' : 'chat'
  const comparedArticle = data?.articles.find(a => !a.deleted && a.id === data.comparisonFocus?.articleId)
  const comparedEvent = data?.events.find(e => e.id === data.comparisonFocus?.eventId && (!data.comparisonFocus?.articleId || comparedArticle?.eventIds.includes(e.id)))
  const sliceLabel = (s?: { kind: 'context' | 'chapter'; id: string }) => !s ? '' : s.kind === 'context' ? (data?.contexts.find(c => c.id === s.id)?.name ?? '') : (data?.chapters.find(c => c.id === s.id)?.title ?? '')
  const sliceNames = data?.comparisonFocus?.sliceA && data?.comparisonFocus?.sliceB ? [sliceLabel(data.comparisonFocus.sliceA), sliceLabel(data.comparisonFocus.sliceB)].filter(Boolean) : []
  const comparisonTitles = sliceNames.length === 2 ? `${sliceNames[0]} vs ${sliceNames[1]}` : [comparedEvent?.title, comparedArticle?.title].filter(Boolean).join(' / ')
  const comparisonPrompt = sliceNames.length === 2 ? '请对照这两个时期或环境：我哪些做法、边界或看重的东西变了？哪些其实没变？请结合原话和反例具体说说。' : '请对照我选的资料：当时的我怎么说？与现在的理解有什么不同？有哪些反例或缺失的证据？没有足够依据就直说。'
  const drafts = new Map<string, Data['proposals']>()
  for (const p of data?.proposals ?? []) if (p.chatReplyId && !p.originId?.startsWith('profile:')) {
    const items = drafts.get(p.chatReplyId) ?? []
    items.push(p); drafts.set(p.chatReplyId, items)
  }
  const originals = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message.content]))
  const openLeads = (!activeProposal && !profileFocus && !data?.comparisonFocus && !activeDream && mode !== 'dream' && data)
    ? [
        ...data.proposals
          .filter(p => p.status === 'pending' && !p.originId?.startsWith('profile:') && (p.kind === 'question' || Boolean(p.counterpoint.trim())))
          .sort((a, b) => Number(Boolean(b.counterpoint.trim())) - Number(Boolean(a.counterpoint.trim())) || b.createdAt.localeCompare(a.createdAt))
          .map(p => ({ key: `proposal:${p.id}`, kind: 'proposal' as const, id: p.id, title: p.title, reason: p.basis, counterpoint: p.counterpoint, question: p.content, evidence: p.evidence })),
        ...(data.profileReport?.findings ?? [])
          .filter(f => f.status !== 'withdrawn' && Boolean(f.question.trim()))
          .map(f => ({ key: `profile:${f.id}`, kind: 'profile' as const, id: f.id, title: f.title, reason: f.observation, counterpoint: f.limits, question: f.question, evidence: f.evidence })),
      ].filter(lead => !skippedLeads.includes(lead.key)).slice(0, 3)
    : []

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
    current.current = id; request.current = controller; pendingRef.current = true; setPending(true); setInput(''); setError(''); setProgress('正在准备回复…')
    setMessages(old => [...old, { id, role: 'user', content: message, createdAt: at, evidence: [], dream: mode === 'dream' }, { id: assistant, role: 'assistant', content: '', createdAt: at, evidence: [], dream: mode === 'dream' }])
    let saved = false
    let savedAssistantId = assistant
    function handle(event: Update) {
      if (event.type === 'delta' && current.current === id) setProgress('正在回复…')
      if (event.type === 'delta') setMessages(old => old.map(m => m.id === assistant ? { ...m, content: m.content + event.text } : m))
      if (event.type === 'progress' && current.current === id) setProgress(event.phase === 'diary' ? '正在本地查找日记原文…' : event.phase === 'chat-history' ? '正在本地查找长期对话原话…' : event.phase === 'memory' ? '正在查找相关事件和百科…' : '正在准备回复…')
      if (event.type === 'saved') {
        saved = true
        savedAssistantId = event.id
        setMessages(old => old.map(m => m.id === assistant ? { ...m, id: event.id, evidence: event.evidence, dream: event.dream, dreamDraft: event.dreamDraft } : m.id === id ? { ...m, id: event.userId, dream: event.dream } : m))
        if (current.current === id) { setProgress(event.dream ? '' : '回复已保存，正在整理画像与归档建议…') }
      }
      if (event.type === 'done') {
        if (event.profileUpdates?.length || event.correctedFocus) {
          setTurnFeedback(prev => ({ ...prev, [savedAssistantId]: { profileUpdates: event.profileUpdates, correctedFocus: event.correctedFocus } }))
        }
        if (current.current === id) setProgress(event.warning ?? [event.profileChanged ? `已更新 ${event.profileChanged} 条画像。` : '', event.notice ?? (event.count ? `已放入 ${event.count} 条待核对建议。` : '')].filter(Boolean).join(' '))
        void changed().catch(() => {})
      }
      if (event.type === 'error') throw new Error(event.error)
    }
    try {
      const res = await fetch('/api/personal/chat', { ...body({ message, mode, allowDiary }), signal: controller.signal })
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
        if (current.current === id) setProgress(previous => previous === '回复已保存，正在整理画像与归档建议…' ? '' : previous)
      } finally { await reader.cancel().catch(() => {}) }
    } catch (err) {
      if (!saved) { setMessages(old => old.filter(m => m.id !== id && m.id !== assistant)); setInput(value => value || message) }
      if (current.current === id && !controller.signal.aborted) { setProgress(''); setError((err as Error).message) }
    } finally {
      if (current.current === id) { pendingRef.current = false; setPending(false); request.current = null }
    }
  }

  return <div hidden={hidden}><Page kicker="同一个对话" title="长期对话" hint="随时接着聊。需要核对旧事时，AI 可以主动查资料。切换聊天方式不会新建对话。" actions={<button type="button" onClick={openDiary}>分析日记</button>}>
    {data?.comparisonFocus && <div className={styles.banner}><span>{comparisonTitles ? '已带入对照：' + comparisonTitles : '选中的对照资料已变更或移除。'}</span><div className={styles.actions}>
      {comparisonTitles && <button type="button" disabled={pending || !!input.trim()} onClick={() => setInput(comparisonPrompt)}>填入对照问题</button>}
      <button type="button" onClick={() => void work(() => api('/focus', body({ comparison: null })))}>退出对照</button>
    </div></div>}
    {profileFocus && <aside className={styles.card}>
      <p className={styles.kicker}>个人画像 · 在同一个长期对话里核对</p>
      <h2>{profileFocus.title}</h2>
      <p><strong>当前判断：</strong>{profileFocus.basis}</p>
      <p><strong>AI 想问你：</strong>{profileFocus.content}</p>
      <EvidenceList evidence={profileFocus.evidence} />
      <p className={styles.muted}>直接回答、补充经历或指出哪里不对。有新依据时，回复后的整理会自动修订画像，不会改写百科。</p>
      <div className={styles.actions}>
        <button type="button" onClick={openProfile}>查看画像</button>
        <button type="button" disabled={pending} onClick={() => void work(() => api('/focus', body({ id: null })))}>结束核对</button>
      </div>
    </aside>}
    {activeProposal && !profileFocus && <aside className={styles.card}>
      <p className={styles.kicker}>待核对线索 · 在同一个长期对话里澄清</p>
      <h2>{activeProposal.title}</h2>
      <p><strong>为什么这样猜：</strong>{activeProposal.basis}</p>
      {activeProposal.counterpoint && <p><strong>反例或适用边界：</strong>{activeProposal.counterpoint}</p>}
      <p><strong>想跟你核对：</strong>{activeProposal.content}</p>
      <EvidenceList evidence={activeProposal.evidence} />
      <div className={styles.actions}>
        <button type="button" disabled={pending || !!input.trim()} onClick={() => setInput(`针对「${activeProposal.title}」，我的实际情况是：`)}>填入回答开头</button>
        <button type="button" disabled={pending} onClick={() => void work(() => api('/focus', body({ id: null })))}>退出此话题</button>
      </div>
    </aside>}
    {openLeads.length > 0 && <details className={styles.details} open><summary>搭档想先跟你核对的 {openLeads.length} 条线索（有依据与反例）</summary>
      <div className={styles.stack}>{openLeads.map(lead => <section className={styles.segment} key={lead.key}>
        <small>{lead.kind === 'proposal' ? '待核对判断' : '画像待验证'}</small>
        <strong> {lead.title}</strong>
        <p className={styles.preserve}><strong>现有线索：</strong>{lead.reason}</p>
        {lead.counterpoint && <p className={styles.muted}>反例 / 边界：{lead.counterpoint}</p>}
        {lead.question && <p className={styles.preserve}><strong>想问你：</strong>{lead.question}</p>}
        {lead.evidence[0] && <blockquote className={styles.quote}><small>{lead.evidence[0].date ?? '日期未知'}</small><p className={styles.preserve}>{lead.evidence[0].quote.slice(0, 140)}{lead.evidence[0].quote.length > 140 ? '…' : ''}</p></blockquote>}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={pending} onClick={() => {
            if (lead.kind === 'proposal') void work(() => api('/focus', body({ id: lead.id })))
            else if (data?.profileReport) void work(() => api('/profile/discuss', body({ reportId: data.profileReport!.id, findingId: lead.id })))
          }}>就聊这条</button>
          <button type="button" disabled={pending} onClick={() => setSkippedLeads(prev => [...prev, lead.key])}>先跳过</button>
        </div>
      </section>)}</div>
    </details>}
    {data?.diaryFocusId && <div className={styles.banner}><span>这次对话带着已选日记批次的综合分析。查日记原文时默认查这批，也可以指定全部日记。</span><button type="button" onClick={() => void work(() => api('/focus', body({ clearDiary: true })))}>停止带入</button></div>}
    {mode === 'dream' && activeDream && <div className={styles.banner}><span>仅在这段讨论中带入梦境：{activeDream.title}</span><button type="button" onClick={async () => { if (await work(() => api('/focus', body({ dreamId: null })))) setModeChoice(undefined) }}>结束梦境讨论</button></div>}
    {error && <p role="alert" className={styles.error}>{error} {!loaded && <button type="button" onClick={() => void load()}>重试</button>}</p>}
    {!messages.length && <Empty>{loaded ? '可以从最近一件值得记的事，或你一直想弄懂的选择聊起。' : '正在读取长期对话…'}</Empty>}
    <div className={styles.conversation}>
      {messages.filter(m => m.content).map(m => {
        const feedback = turnFeedback[m.id]
        return <article className={m.role === 'user' ? styles.userMessage : styles.assistantMessage} key={m.id}>
          <small>{m.role === 'user' ? '我' : 'AI 分析搭档'}{m.dream && ' · 梦境讨论'} · {stamp(m.createdAt)}</small>
          {m.role === 'assistant' ? <CitedReply message={m} /> : <p className={styles.preserve}>{m.content}</p>}
          {feedback && (feedback.correctedFocus || feedback.profileUpdates?.length) && <aside className={styles.chatSuggestion}>
            {feedback.correctedFocus && <div className={styles.stack}><strong>已记下你的明确纠正</strong><p className={styles.preserve}>{feedback.correctedFocus.title}：{feedback.correctedFocus.correction}</p></div>}
            {feedback.profileUpdates?.map(u => <div className={styles.segment} key={u.id}>
              <small>本轮同步更新画像 · {profileStatusLabel[u.status]}</small>
              <strong> {u.title}</strong>
              <p className={styles.preserve}>{u.observation}</p>
              {u.limits && <p className={styles.muted}>适用条件：{u.limits}</p>}
              <p className={styles.muted}>原因：{u.reason}</p>
              <div className={styles.actions}>
                <button type="button" onClick={openProfile}>查看画像</button>
                {data?.profileReport && u.status !== 'withdrawn' && <button type="button" disabled={pending} onClick={() => void work(() => api('/profile/discuss', body({ reportId: data.profileReport!.id, findingId: u.id })))}>不对，继续核对这条</button>}
              </div>
            </div>)}
          </aside>}
          {data && drafts.get(m.id)?.map(p => <ProposalCard key={p.id} p={p} data={data} work={work} openEvent={openEvent} openArticle={openArticle} compact />)}
          {m.dreamDraft && <ChatDreamCard replyId={m.id} original={originals.get(m.dreamDraft.userId) ?? ''} work={work} />}
        </article>
      })}
      <div ref={bottom} />
    </div>
    <form onSubmit={send} className={styles.composer}>
      {progress && <p role="status">{progress}</p>}
      <label className={styles.field}><span>给分析搭档留言</span><textarea value={input} onChange={e => setInput(e.target.value)} maxLength={24000} rows={3} placeholder="最近有件事，我想重新看看……" /></label>
      <div className={styles.actions}>
        <label>聊天方式 <select value={mode} disabled={pending || Boolean(profileFocus)} onChange={e => setModeChoice({ mode: e.target.value as ChatMode, dreamId: activeDream?.id })}>
          <option value="chat">普通聊聊</option><option value="event">记事件</option><option value="dream">聊梦境</option>
        </select></label>
        <label className={styles.archiveToggle} title="关闭后不会新查日记或带入选中的日记分析；不影响已有聊天与存档条目。"><input type="checkbox" checked={allowDiary && mode !== 'dream'} onChange={e => setAllowDiary(e.target.checked)} disabled={pending || mode === 'dream'} />允许按需查日记</label>
      </div>
      <div className={styles.actions}><button className={styles.primary} disabled={pending || !loaded || !input.trim()}>发送</button><small>发送会把本轮对话和选中的少量相关资料交给已配置的聊天 API。</small></div>
    </form>
    <Archive useDiary={diaryId => work(() => api('/focus', body({ diaryId })), '已带入这批历史分析，不会重新发送全部原文。')} />
  </Page></div>
}
