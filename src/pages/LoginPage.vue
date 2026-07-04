<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { isDemoMode } from '@/lib/supabase'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submit(): Promise<void> {
  error.value = null
  busy.value = true
  try {
    await auth.signIn(email.value, password.value)
    await router.push('/admin')
  } catch {
    error.value = t('login.error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page narrow">
    <div class="card">
      <h1>{{ t('login.title') }}</h1>
      <p v-if="isDemoMode" class="muted">
        Demo mode — configure VITE_SUPABASE_URL to enable admin sign-in.
      </p>
      <form v-else @submit.prevent="submit">
        <label>
          {{ t('login.email') }}
          <input v-model="email" type="email" autocomplete="username" required />
        </label>
        <label>
          {{ t('login.password') }}
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn" type="submit" :disabled="busy">{{ t('login.submit') }}</button>
      </form>
      <p class="muted back"><RouterLink to="/">← {{ t('app.title') }}</RouterLink></p>
    </div>
  </div>
</template>

<style scoped>
.narrow {
  max-width: 420px;
  padding-top: 48px;
}

label {
  display: block;
  margin-bottom: 14px;
  font-size: 0.9rem;
  color: var(--text-secondary);
}

input {
  margin-top: 4px;
}

.error {
  color: var(--verdict-unsafe-accent);
  font-size: 0.9rem;
}

.back {
  margin-top: 16px;
}
</style>
