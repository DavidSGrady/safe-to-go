import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** True when no Supabase project is configured — the app then shows demo data. */
export const isDemoMode = !url || !anonKey

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (isDemoMode) {
    throw new Error('Supabase is not configured (demo mode)')
  }
  if (!client) {
    client = createClient(url!, anonKey!)
  }
  return client
}
