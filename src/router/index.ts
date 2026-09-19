import { createRouter, createWebHistory, START_LOCATION } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { isDemoMode } from '@/lib/supabase'
import { recordPageview } from '@/lib/analytics'
import { i18n } from '@/i18n'
import DataPage from '@/pages/DataPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // The raw-data page is the public front page while the verdict page is
    // still being iterated on with users. Old /data links keep working.
    { path: '/', name: 'home', component: DataPage },
    { path: '/data', redirect: '/' },
    {
      path: '/status',
      name: 'status',
      component: () => import('@/pages/HomePage.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/pages/LoginPage.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/pages/AdminPage.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/display',
      name: 'display',
      component: () => import('@/pages/DisplayPage.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  if (!to.meta.requiresAdmin) return true
  if (isDemoMode) return { name: 'login' }
  const auth = useAuthStore()
  await auth.init()
  if (!auth.session) return { name: 'login' }
  return true
})

// Cookieless visit counting. afterEach is the right hook: it covers the initial
// navigation AND every SPA transition with one listener, and it cannot fire on
// the store's 5-minute poll or its visibilitychange refresh, because neither
// navigates. recordPageview() no-ops outside production and in demo mode, and
// only counts the routes in its whitelist.
router.afterEach((to, from) => {
  // Compare `path`, not `fullPath`, so a query-only change is not a second
  // pageview. `from === START_LOCATION` is the first load, which does count.
  if (from !== START_LOCATION && to.path === from.path) return
  recordPageview(to.path, i18n.global.locale.value)
})

export default router
