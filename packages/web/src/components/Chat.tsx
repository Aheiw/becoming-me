import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { useVoiceInput } from '../hooks/useVoiceInput.js'
import { useProgress } from '../hooks/useProgress.js'
import { useChat } from '../hooks/useChat.js'
import { CATEGORY_TO_LAYER } from '../constants/layers.js'
import VoiceMode from './VoiceMode.js'
import ProgressHeader from './ProgressHeader.js'
import InterviewHistoryPanel from './InterviewHistoryPanel.js'
import styles from './Chat.module.css'

export default function Chat({ local = false, onAddDiaries }: { local?: boolean; onAddDiaries?: () => void }) {
  const { t, i18n } = useTranslation()
  const { progress, savedNotice, refreshProgress } = useProgress()
  const [ttsAvailable, setTtsAvailable] = useState(false)
  const {
    sessionId, messages, input, setInput,
    loading, ended, voiceMode, setVoiceMode,
    modelError, rateLimitHit, remainingTurns, sessionSummary,
    bottomRef, lastCoachMessage,
    sendMessage, endSessionNow, skipQuestion, resetSession, addMessages, setEnded,
    chatError, openSession, restoreLocal,
  } = useChat(refreshProgress, local)
  const voice = useVoiceInput((text) => setInput(text))

  useEffect(() => {
    fetch('/api/tts/health')
      .then(res => res.json())
      .then(data => setTtsAvailable(data.available))
      .catch(() => setTtsAvailable(false))
  }, [])

  if (rateLimitHit) {
    return (
      <div className={styles.container}>
      <header className={styles.chatHead}><h1>{t('app.nav.interview')}</h1><p>{t('chat.intro', { defaultValue: 'Continue the conversation about what matters to you.' })}</p></header>
        <div className={styles.rateLimitBanner}>
          <p className={styles.rateLimitTitle}>{t('demo.rateLimitTitle')}</p>
          <p className={styles.rateLimitBody}>{t('demo.rateLimitBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {voiceMode && sessionId && (
        <VoiceMode
          sessionId={sessionId}
          language={i18n.language}
          initialCoachMessage={lastCoachMessage}
          ended={ended}
          onClose={() => { setVoiceMode(false); refreshProgress() }}
          onExchange={(userMsg, coachMsg) => { addMessages(userMsg, coachMsg); refreshProgress() }}
          onEnd={endSessionNow}
        />
      )}
      <ProgressHeader data={progress} remainingTurns={remainingTurns} />
      {savedNotice !== null && (
        <div className={styles.savedNotice}>+{savedNotice}</div>
      )}

      {local && onAddDiaries && <InterviewHistoryPanel sessionId={sessionId} busy={loading || voiceMode} onOpen={openSession} onAddDiaries={onAddDiaries} />}
      <div className={styles.messages}>
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`${styles.messageRow} ${msg.role === 'user' ? styles.messageRowUser : styles.messageRowAssistant}`}
          >
            <div className={`${styles.bubble} ${msg.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant}`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className={styles.messageRowAssistant}>
            <div className={styles.typing}>{t('chat.typing')}</div>
          </div>
        )}
        {ended && (
          <div className={styles.sessionEndedBar}>
            {t('chat.sessionEnded')}
            <button className={styles.newSessionBtn} disabled={loading} onClick={resetSession}>
              {local ? '开始下一轮（保留历史）' : t('chat.newSession')}
            </button>
          </div>
        )}
        {ended && sessionSummary && (
          <div className={styles.sessionSummary}>
            <div className={styles.sessionSummaryTitle}>{t('chat.summaryTitle')}</div>
            {Object.keys(sessionSummary.facts).length > 0 && (
              <div className={styles.sessionSummaryRow}>
                {Object.entries(sessionSummary.facts).map(([cat, n]) => (
                  <span key={cat} className={styles.summaryTag}>
                    <span className={styles.summaryTagLayer}>{CATEGORY_TO_LAYER[cat] ?? '?'}</span>
                    {t(`dashboard.layers.${CATEGORY_TO_LAYER[cat]}`, { defaultValue: cat })} ×{n}
                  </span>
                ))}
              </div>
            )}
            {sessionSummary.timeline > 0 && (
              <div className={styles.sessionSummaryRow}>
                <span className={styles.summaryTag}>
                  <span className={styles.summaryTagLayer}>L3</span>
                  {t('dashboard.timelineHeading')} ×{sessionSummary.timeline}
                </span>
              </div>
            )}
            {sessionSummary.vignettes.length > 0 && (
              <div className={styles.sessionSummaryRow}>
                {sessionSummary.vignettes.map((title, i) => (
                  <span key={i} className={`${styles.summaryTag} ${styles.summaryTagVignette}`}>
                    <span className={styles.summaryTagLayer}>{t('chat.lifeChapters', { defaultValue: 'Life chapters' })}</span>
                    📖 {title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className={styles.inputArea}>
        {!ended && messages.length >= 1 && sessionId && (
          <div className={styles.skipRow}>
            <button className={styles.skipBtn} onClick={skipQuestion} disabled={loading}>
              {t('chat.skip')}
            </button>
          </div>
        )}
        {modelError && (
          <div className={styles.modelErrorBanner}>
            <strong>{t('chat.modelError')}</strong><br />
            {modelError}
          </div>
        )}
        {chatError && <div className={styles.errorMsg} role="alert">{chatError}{!sessionId && <button type="button" disabled={loading} onClick={restoreLocal}>重试</button>}</div>}
        {voice.error && <div className={styles.errorMsg}>{voice.error}</div>}
        <div className={styles.inputRow}>
          {sessionId && !ended && (
            <button
              onClick={endSessionNow}
              disabled={loading}
              data-tooltip={t('chat.endSessionTooltip')}
              className={styles.endBtn}
            >
              {t('chat.endSession')}
            </button>
          )}
          {sessionId && !ended && (
            <button
              onClick={() => ttsAvailable && setVoiceMode(true)}
              disabled={!ttsAvailable || loading}
              data-tooltip={ttsAvailable ? t('chat.voiceMode') : t('chat.voiceModeDisabled')}
              className={styles.voiceModeBtn}
              style={{ opacity: ttsAvailable ? 1 : 0.5, cursor: ttsAvailable ? 'pointer' : 'not-allowed' }}
            >
              🎧
            </button>
          )}
          {voice.isSupported && (
            <button
              onClick={() => voice.isRecording ? voice.stop() : voice.start(i18n.language)}
              disabled={loading || ended || voice.isTranscribing}
              data-tooltip={voice.isRecording ? t('chat.recordStop') : voice.isTranscribing ? t('chat.transcribing') : t('chat.voiceInput')}
              className={`${styles.micBtn} ${voice.isRecording ? styles.micBtnRecording : ''}`}
            >
              {voice.isTranscribing ? '⏳' : voice.isRecording ? '⏹' : '🎤'}
            </button>
          )}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(i18n.language) } }}
            disabled={loading || ended || !sessionId}
            placeholder={ended ? t('chat.placeholderEnded') : t('chat.placeholder')}
            rows={2}
            className={styles.textarea}
          />
          <button
            onClick={() => sendMessage(i18n.language)}
            disabled={loading || ended || !sessionId || !input.trim()}
            className={styles.sendBtn}
          >
            {t('chat.send')}
          </button>
        </div>
      </div>
    </div>
  )
}
