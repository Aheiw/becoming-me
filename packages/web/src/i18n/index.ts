import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import ja from './ja.json'
import en from './en.json'
import zh from './zh.json'
import { localProfile } from '../lib/localProfile.js'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { ja: { translation: ja }, en: { translation: en }, zh: { translation: zh } },
    fallbackLng: 'zh',
    supportedLngs: localProfile ? ['zh'] : ['zh', 'ja', 'en'],
    ...(localProfile ? { lng: 'zh' } : {}),
    interpolation: { escapeValue: false },
  })

export default i18n

function updateDocumentLanguage(language: string) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : language
}
i18n.on('languageChanged', updateDocumentLanguage)
updateDocumentLanguage(i18n.resolvedLanguage ?? 'zh')
