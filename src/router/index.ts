import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { isDemoMode } from '@/lib/supabase'
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

export default router
