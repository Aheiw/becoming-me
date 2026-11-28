import { mobileClient, requirePairing } from './lib/mobileAccess.js'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'
import SimpleMarkdown from './components/SimpleMarkdown.js'
import Chat from './components/Chat.js'
import Onboarding from './components/Onboarding.js'
import ContextDashboard from './components/ContextDashboard.js'
import PersonalWorkspace, { tabs } from './components/personal/PersonalWorkspace.js'
import type { Tab } from './components/personal/shared.js'

import { localProfile as local } from './lib/localProfile.js'
import { clearLegacyChatCache, maintenanceNotice, recordsChangeKey } from './lib/localMaintenance.js'
import styles from './App.module.css'

type View = 'personal' | 'onboarding' | 'chat' | 'export' | 'dashboard'

interface ExportFiles {
  index: string
  l01Values: string
  l02Character: string
  l03LifeTimeline: string
  l04Professional: string
  l05Relationships: string
  l06Opinions: string
  l07Fears: string
  l08Patterns: string
  l09Goals: string
  l10Preferences: string
  lifeChapters: string
}

interface ExportSection {
  heading: string
  facts: string[]
}

interface ExportLayer {
  key: string
  filename: string
  title: string
  zone: string
  sections: ExportSection[]
  other: string[]
  markdown: string
}

type ExportItemDef =
  | { type: 'special'; key: keyof ExportFiles; name: string }
  | { type: 'layer'; key: string }

const EXPORT_ORDER: ExportItemDef[] = [
  { type: 'special', key: 'index',           name: '_index.md' },
  { type: 'special', key: 'lifeChapters',    name: 'life_chapters.md' },
  { type: 'layer',   key: 'l01Values' },
  { type: 'layer',   key: 'l02Character' },
  { type: 'special', key: 'l03LifeTimeline', name: 'L03_life_timeline.md' },
  { type: 'special', key: 'l04Professional', name: 'L04_professional.md' },
  { type: 'layer',   key: 'l05Relationships' },
  { type: 'layer',   key: 'l06Opinions' },
  { type: 'layer',   key: 'l07Fears' },
  { type: 'layer',   key: 'l08Patterns' },
  { type: 'layer',   key: 'l09Goals' },
  { type: 'layer',   key: 'l10Preferences' },
]

export default function App() {
  const { t, i18n } = useTranslation()
  const [view, setView] = useState<View>(local ? 'personal' : 'chat')
  const [inboxCount, setInboxCount] = useState(0)
  const [tab, setTab] = useState<Tab>(() => local && maintenanceNotice() ? 'settings' : 'overview')
  useEffect(() => {
    if (!local) return
    const reload = (event: StorageEvent) => {
      if (event.key !== recordsChangeKey) return
      clearLegacyChatCache()
      window.location.reload()
    }
    window.addEventListener('storage', reload)
    return () => window.removeEventListener('storage', reload)
  }, [])
  useEffect(() => {
    if (!mobileClient) return
    const controller = new AbortController()
    const check = () => {
      if (document.visibilityState !== 'visible') return
      void fetch('/mobile-connect/status', { cache: 'no-store', signal: controller.signal }).then(requirePairing).catch(() => {})
    }
    check()
    document.addEventListener('visibilitychange', check)
    const timer = window.setInterval(check, 30_000)
    return () => { controller.abort(); document.removeEventListener('visibilitychange', check); window.clearInterval(timer) }
  }, [])
  const openPersonal = (value: Tab) => { setTab(value); setView('personal') }
  const [onboardingDone, setOnboardingDone] = useState(false)
  const openDiary = () => openPersonal('library')
  const openInterview = () => local ? openPersonal('chat') : setView(onboardingDone ? 'chat' : 'onboarding')
  const [exportFiles, setExportFiles] = useState<ExportFiles | null>(null)
  const [exportLayers, setExportLayers] = useState<ExportLayer[]>([])
  const [exportError, setExportError] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/user')
      .then(r => r.json())
      .then((data: { language: string; onboardingCompletedAt: string | null }) => {
        if (!local && data.language && data.language !== i18n.language) {
          i18n.changeLanguage(data.language)
        }
        setOnboardingDone(Boolean(data.onboardingCompletedAt))
        if (!local && !data.onboardingCompletedAt) {
          setView('onboarding')
        }
      })
      .catch(() => {})
  }, [])

  async function switchLanguage(lang: string) {
    await fetch('/api/user', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    })
    i18n.changeLanguage(lang)
  }

  async function handleExport() {
    setExportError('')
    setView('export')
    setExportFiles(null)
    try {
      const res = await fetch('/api/export')
      if (!res.ok) throw new Error()
      const data = await res.json() as { files: ExportFiles; layers: ExportLayer[] }
      setExportFiles(data.files)
      setExportLayers(data.layers ?? [])
    } catch {
      setExportError(t('export.loadError', { defaultValue: 'Could not load the export.' }))
    }
  }

  async function handleDownload() {
    setExportError('')
    let blob: Blob
    try {
      const res = await fetch('/api/export/download')
      if (!res.ok) throw new Error()
      blob = await res.blob()
    } catch {
      setExportError(t('export.downloadError', { defaultValue: 'Could not download the archive.' }))
      return
    }
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = 'becoming-me.zip'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  async function copyContent(key: string, content: string) {
    await navigator.clipboard.writeText(content)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  const onboarding = view === 'onboarding'

  return (
    <div className={styles.app}>
      {import.meta.env.VITE_DEMO_MODE === 'true' && (
        <div style={{ background: '#1a1a2e', color: '#aaa', fontSize: 12, textAlign: 'center', padding: '6px 16px' }}>
          {t('app.demo.notice')}
        </div>
      )}
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V7m0 0C9 4 5 4 3 5v12c3-1 6 0 9 3 3-3 6-4 9-3V5c-2-1-6-1-9 2Z"/><path d="M6 9c1 0 2 .3 3 1m6 0c1-.7 2-1 3-1"/></svg></span>
          <span className={styles.title}>{t('app.title')}</span>
        </div>
        <nav className={styles.nav} aria-label={t('app.navigation', { defaultValue: 'Main navigation' })}>
          {local ? <>
            {tabs.map(({ id, title }) => <button type="button" key={id} className={styles.navBtn} aria-current={view === 'personal' && tab === id ? 'page' : undefined} onClick={() => openPersonal(id)}>{title}{id === 'inbox' && inboxCount > 0 && ` · ${inboxCount}`}</button>)}
            {view === 'dashboard' && <button type="button" className={styles.navBtn} onClick={handleExport}>原版导出</button>}
          </> : <>
          <button
            onClick={() => setView('dashboard')}
            disabled={onboarding}
            aria-current={view === 'dashboard' ? 'page' : undefined}
            className={styles.navBtn}
          >
            {t('app.nav.myContext')}
          </button>
          <button
            onClick={openInterview}
            disabled={onboarding}
            aria-current={view === 'chat' ? 'page' : undefined}
            className={styles.navBtn}
          >
            {t('app.nav.interview')}
          </button>
          <button
            onClick={() => handleExport()}
            disabled={onboarding}
            aria-current={view === 'export' ? 'page' : undefined}
            className={styles.navBtn}
          >
            {t('app.nav.export')}
          </button>
          {!local && (
            <div className={styles.langGroup}>
              {['zh', 'ja', 'en'].map(lang => (
                <button
                  key={lang}
                  onClick={() => switchLanguage(lang)}
                  className={`${styles.langBtn} ${i18n.language === lang ? styles.langBtnActive : ''}`}
                >
                  {lang === 'zh' ? '中文' : lang.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {import.meta.env.VITE_CLERK_PUBLISHABLE_KEY && import.meta.env.VITE_DEMO_MODE !== 'true' && (
            <div className={styles.authGroup}>
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button type="button" className={styles.authBtn}>{t('app.auth.signIn')}</button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button type="button" className={styles.authBtn}>{t('app.auth.signUp')}</button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          )}
          </>}
        </nav>
      </header>

      <main className={styles.main}>
        {local && <PersonalWorkspace tab={tab} setTab={setTab} onInboxCount={setInboxCount} active={view === 'personal'} legacy={() => setView('dashboard')} />}
        {view === 'onboarding' && <Onboarding onComplete={() => { setOnboardingDone(true); setView('chat') }} />}
        {view === 'chat' && <Chat local={local} onAddDiaries={openDiary} />}
        {view === 'dashboard' && <ContextDashboard onStartInterview={openInterview} onAddDiaries={local ? openDiary : undefined} />}
        {view === 'export' && !exportFiles && <div className={styles.exportContainer}><p role={exportError ? 'alert' : 'status'}>{exportError || t('dashboard.loading')}</p>{exportError && <button className={styles.downloadBtn} onClick={handleExport}>{t('dashboard.retry', { defaultValue: 'Retry' })}</button>}</div>}
        {view === 'export' && exportFiles && (
          <div className={styles.exportContainer}>
            <div className={styles.downloadSection}>
              <h1 className={styles.exportTitle}>{t('app.nav.export')}</h1>
              <button
                onClick={handleDownload}
                className={styles.downloadBtn}
              >
                <span className={styles.downloadIcon} aria-hidden="true">↓</span>
                {t('export.downloadZip')}
              </button>
            </div>
            {exportError && <p role="alert" className={styles.exportError}>{exportError}</p>}
            <div className={styles.exportGrid}>
            {(() => {
              const layerMap = Object.fromEntries(exportLayers.map(l => [l.key, l]))
              return EXPORT_ORDER.map((item) => {
                if (item.type === 'special') {
                  return (
                    <div key={item.key} className={styles.exportCard}>
                      <div className={styles.exportCardHeader}>
                        <span className={styles.exportFilename}>{item.name}</span>
                        <button
                          onClick={() => copyContent(item.key, exportFiles[item.key])}
                          className={`${styles.copyBtn} ${copiedKey === item.key ? styles.copyBtnSuccess : ''}`}
                        >
                          {copiedKey === item.key ? t('export.copied', { defaultValue: 'Copied' }) : t('export.copy')}
                        </button>
                      </div>
                      <div className={styles.exportContent}>
                    <SimpleMarkdown>{exportFiles[item.key]}</SimpleMarkdown>
                  </div>
                    </div>
                  )
                }
                const layer = layerMap[item.key]
                if (!layer) return null
                const isEmpty = layer.sections.length === 0 && layer.other.length === 0
                return (
                  <div key={layer.key} className={styles.exportCard}>
                    <div className={styles.exportCardHeader}>
                      <span className={styles.exportFilename}>{layer.filename}</span>
                      <span className={styles.zoneTag}>{t(`progress.zones.${layer.zone}`)}
                      </span>
                      <button
                        onClick={() => copyContent(layer.key, layer.markdown)}
                        className={`${styles.copyBtn} ${copiedKey === layer.key ? styles.copyBtnSuccess : ''}`}
                      >
                        {copiedKey === layer.key ? t('export.copied', { defaultValue: 'Copied' }) : t('export.copy')}
                      </button>
                    </div>
                    <div className={styles.layerBody}>
                      {isEmpty ? (
                        <p className={styles.emptyNote}>{t('dashboard.noData')}</p>
                      ) : (
                        <>
                          {layer.sections.map((sec) => (
                            <div key={sec.heading} className={styles.layerSection}>
                              <h3 className={styles.sectionHeading}>{sec.heading}</h3>
                              <ul className={styles.factList}>
                                {sec.facts.map((fact, i) => (
                                  <li key={i}>{fact}</li>
                                ))}
                              </ul>
                            </div>
                          ))}
                          {layer.other.length > 0 && (
                            <div className={styles.layerSection}>
                              <h3 className={styles.sectionHeading}>{t('export.other', { defaultValue: 'Other' })}</h3>
                              <ul className={styles.factList}>
                                {layer.other.map((fact, i) => (
                                  <li key={i}>{fact}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })
            })()}
          </div>
          </div>
        )}
      </main>
    </div>
  )
}
