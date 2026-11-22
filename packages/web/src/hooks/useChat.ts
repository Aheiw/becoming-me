import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { interviewHistoryRequest, type InterviewHistory, type InterviewSession } from '../lib/interviewHistory.js'

const SESSION_KEY = 'chat_session'

export type Message = { role: 'assistant' | 'user'; content: string }
export type SessionSummary = { facts: Record<string, number>; timeline: number; vignettes: string[] }

export function useChat(refreshProgress: () => Promise<void>, local: boolean) {
  const { i18n } = useTranslation()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const initialized = useRef(false)
  const [chatError, setChatError] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [ended, setEnded] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [rateLimitHit, setRateLimitHit] = useState(false)
  const [remainingTurns, setRemainingTurns] = useState<number | null>(null)
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (local) {
      void restoreLocal()
      refreshProgress()
      return
    }
    const saved = sessionStorage.getItem(SESSION_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { sessionId: string; messages: Message[]; ended: boolean }
        setSessionId(parsed.sessionId)
        setMessages(parsed.messages)
        setEnded(parsed.ended)
      } catch {
        startSession()
      }
    } else {
      startSession()
    }
    refreshProgress()
  }, [])

  useEffect(() => {
    if (!local && sessionId) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, messages, ended }))
    }
  }, [sessionId, messages, ended])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadSession(id: string) {
    const data = await interviewHistoryRequest<Pick<InterviewSession, 'id' | 'type' | 'status'> & { messages: Message[] }>(`/sessions/${id}`)
    setSessionId(data.id)
    setMessages(data.messages)
    setInput('')
    setEnded(data.status !== 'active' || data.type !== 'regular')
    setVoiceMode(false)
    setModelError(null)
    setRemainingTurns(null)
    setSessionSummary(null)
  }

  async function restoreLocal() {
    setLoading(true)
    setChatError('')
    try {
      const data = await interviewHistoryRequest<InterviewHistory>()
      const regular = data.sessions.filter(session => session.type === 'regular')
      const latest = regular.find(session => session.status === 'active') ?? regular[0]
      if (latest) await loadSession(latest.id)
      else await startSession()
    } catch (err) { setChatError(err instanceof TypeError ? '无法连接本地 PCE，请确认服务正在运行后重试。' : (err as Error).message) }
    finally { setLoading(false) }
  }

  async function openSession(id: string) {
    if (!local || loading) return
    setLoading(true)
    setChatError('')
    try { await loadSession(id) }
    catch (err) { setChatError(err instanceof TypeError ? '无法连接本地 PCE，请确认服务正在运行后重试。' : (err as Error).message) }
    finally { setLoading(false) }
  }

  async function startSession() {
    setLoading(true)
    setChatError('')
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: i18n.language }),
      })
      if (res.status === 429) { setRateLimitHit(true); return }
      const data = await res.json() as { sessionId: string; message: string }
      if (!res.ok || !data.sessionId) throw new Error('无法开始访谈，请重试。')
      setEnded(false)
      setRemainingTurns(null)
      setSessionSummary(null)
      setModelError(null)
      setInput('')
      setSessionId(data.sessionId)
      setMessages([{ role: 'assistant', content: data.message }])
    } catch (err) {
      if (local) setChatError(err instanceof TypeError ? '无法连接本地 PCE，请确认服务正在运行后重试。' : (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function sendMessage(language?: string) {
    if (!input.trim() || !sessionId || loading || ended) return
    const userMessage = input.trim()
    setChatError('')
    setModelError(null)
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: userMessage, language }),
      })
      const data = await res.json() as { response?: string; shouldEnd?: boolean; remainingTurns?: number | null; summary?: SessionSummary; error?: string; code?: string }
      if (!res.ok) {
        if (local) throw new Error(data.code === 'MODEL_NOT_SUPPORTED' ? '模型没有返回可用的访谈回复，请重试。' : data.error ?? '这次回复未完成，请重试。')
        if (data.code === 'MODEL_NOT_SUPPORTED') setModelError(data.error ?? 'Model does not support structured output.')
        setMessages(prev => [...prev, { role: 'assistant', content: '...' }])
        return
      }
      setMessages(prev => [...prev, { role: 'assistant', content: data.response! }])
      if (data.shouldEnd) {
        setEnded(true)
        if (data.summary) {
          setSessionSummary(data.summary)
        } else {
          await fetchEndSummary(sessionId)
        }
      }
      if (data.remainingTurns !== undefined) setRemainingTurns(data.remainingTurns)
      refreshProgress()
    } catch (err) {
      if (local) {
        setMessages(prev => prev.slice(0, -1))
        setInput(userMessage)
        setChatError(err instanceof TypeError ? '连接中断，发送前请先查看访谈历史确认是否已收到回复。' : (err as Error).message)
      } else setMessages(prev => [...prev, { role: 'assistant', content: '...' }])
    } finally {
      setLoading(false)
    }
  }

  async function endSessionNow() {
    if (!sessionId || ended || loading) return
    setLoading(true)
    setChatError('')
    try {
      const completed = await fetchEndSummary(sessionId)
      if (completed || !local) setEnded(true)
      else setChatError('未能确认本轮已结束。请重新查看访谈历史。')
      refreshProgress()
    } finally { setLoading(false) }
  }

  async function skipQuestion() {
    if (!sessionId || ended || loading) return
    setLoading(true)
    setChatError('')
    try {
      const res = await fetch(`/api/sessions/${sessionId}/skip`, { method: 'POST' })
      const data = await res.json() as { message: string; remainingTurns: number | null }
      if (!res.ok || !data.message) throw new Error('未能跳过问题，请重试。')
      setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
      if (data.remainingTurns !== undefined) setRemainingTurns(data.remainingTurns)
    } catch (err) {
      if (local) setChatError(err instanceof TypeError ? '无法连接本地 PCE，请确认服务正在运行后重试。' : (err as Error).message)
      else console.error('[skip] failed:', err)
    } finally {
      setLoading(false)
    }
  }

  function resetSession() {
    if (loading) return
    if (local) { void startSession(); return }
    sessionStorage.removeItem(SESSION_KEY)
    setEnded(false)
    setMessages([])
    setSessionId(null)
    setRemainingTurns(null)
    setSessionSummary(null)
    startSession()
  }

  async function fetchEndSummary(sid: string) {
    try {
      const res = await fetch(`/api/sessions/${sid}/end`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { ok: boolean; summary?: SessionSummary }
        if (data.summary) setSessionSummary(data.summary)
        return true
      }
    } catch (err) {
      if (!local) console.error('[end] failed:', err)
    }
    return false
  }

  const lastCoachMessage = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? ''

  function addMessages(userMsg: string, coachMsg: string) {
    setMessages(prev => [
      ...prev,
      { role: 'user', content: userMsg },
      { role: 'assistant', content: coachMsg },
    ])
  }

  return {
    sessionId, messages, input, setInput,
    loading, ended, setEnded, voiceMode, setVoiceMode,
    modelError, rateLimitHit, remainingTurns, sessionSummary,
    bottomRef, lastCoachMessage,
    chatError, openSession, restoreLocal, startSession, sendMessage, endSessionNow, skipQuestion, resetSession, addMessages,
  }
}
