import { createI18n } from 'vue-i18n'
import en from './en.js'
import nl from './nl.js'

// Persist language preference
const saved = localStorage.getItem('lang') || 'en'

const i18n = createI18n({
  legacy: false,          // use Composition API mode
  locale: saved,
  fallbackLocale: 'en',
  messages: { en, nl },
})

export default i18n
