import { createI18n } from 'vue-i18n'
import da from './locales/da.json'
import en from './locales/en.json'
import de from './locales/de.json'
import nl from './locales/nl.json'
import fr from './locales/fr.json'
import es from './locales/es.json'
import zh from './locales/zh.json'

export const SUPPORTED_LOCALES = [
  { code: 'da', label: 'Dansk' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文' },
] as const

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code']

function initialLocale(): LocaleCode {
  const saved = localStorage.getItem('locale')
  if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) {
    return saved as LocaleCode
  }
  const nav = navigator.language.slice(0, 2).toLowerCase()
  if (SUPPORTED_LOCALES.some((l) => l.code === nav)) return nav as LocaleCode
  return 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { da, en, de, nl, fr, es, zh },
})

export function setLocale(code: LocaleCode): void {
  i18n.global.locale.value = code
  localStorage.setItem('locale', code)
  document.documentElement.lang = code
}
