import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Session } from '@supabase/supabase-js'
import { getSupabase, isDemoMode } from '@/lib/supabase'

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(null)
  const role = ref<'viewer' | 'admin' | null>(null)
  const initialized = ref(false)

  const isAdmin = computed(() => role.value === 'admin')

  async function loadRole(): Promise<void> {
    if (!session.value) {
      role.value = null
      return
    }
    const { data } = await getSupabase()
      .from('profiles')
      .select('role')
      .eq('id', session.value.user.id)
      .single()
    role.value = (data?.role as 'viewer' | 'admin') ?? 'viewer'
  }

  async function init(): Promise<void> {
    if (initialized.value || isDemoMode) {
      initialized.value = true
      return
    }
    const supabase = getSupabase()
    const { data } = await supabase.auth.getSession()
    session.value = data.session
    await loadRole()
    supabase.auth.onAuthStateChange((_event, newSession) => {
      session.value = newSession
      void loadRole()
    })
    initialized.value = true
  }

  async function signIn(email: string, password: string): Promise<void> {
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    session.value = data.session
    await loadRole()
  }

  async function signOut(): Promise<void> {
    await getSupabase().auth.signOut()
    session.value = null
    role.value = null
  }

  return { session, role, isAdmin, initialized, init, signIn, signOut }
})
