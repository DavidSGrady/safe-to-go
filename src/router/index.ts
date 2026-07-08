import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { isDemoMode } from '@/lib/supabase'
import HomePage from '@/pages/HomePage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
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
      path: '/data',
      name: 'data',
      component: () => import('@/pages/DataPage.vue'),
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
