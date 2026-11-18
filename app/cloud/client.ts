import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let browserClient: SupabaseClient | undefined

/** The publishable key identifies the app; authorization is enforced by RLS. */
export function getCloudClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('Облачное хранилище не настроено')
  return browserClient ??= createClient(url, key)
}

const pendingSessions = new WeakMap<SupabaseClient, Promise<void>>()
export async function ensureAnonymousSession(client = getCloudClient()): Promise<void> {
  const existing = pendingSessions.get(client)
  if (existing) return existing
  const pending = (async () => {
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    if (data.session) return
    const result = await client.auth.signInAnonymously()
    if (result.error) throw new Error('Не удалось войти в комнату. Проверьте, включён ли анонимный вход в Supabase.')
  })().finally(() => { pendingSessions.delete(client) })
  pendingSessions.set(client, pending)
  return pending
}
