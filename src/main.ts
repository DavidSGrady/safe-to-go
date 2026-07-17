import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import './assets/styles.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
app.mount('#app')

document.documentElement.lang = i18n.global.locale.value

// Push-only service worker (public/sw.js) — required for web push, including
// iOS home-screen installs. Failure is non-fatal: the app works without it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
