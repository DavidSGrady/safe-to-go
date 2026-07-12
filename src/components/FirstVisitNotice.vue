<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

// Shown above the verdict until dismissed, so the caveats are seen *before*
// the first green state — a footer-only disclaimer doesn't count for much.
// Bump the key suffix if the notice text changes materially.
const STORAGE_KEY = 'stg-notice-dismissed-v1'

const { t } = useI18n()

const dismissed = ref(false)
try {
  dismissed.value = localStorage.getItem(STORAGE_KEY) === '1'
} catch {
  // Storage unavailable (private mode) — show the notice every visit.
}

function dismiss() {
  dismissed.value = true
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Ignore — the notice will simply reappear next visit.
  }
}
</script>

<template>
  <section v-if="!dismissed" class="notice" role="note">
    <h2 class="notice-title">{{ t('notice.title') }}</h2>
    <p>{{ t('notice.body1') }}</p>
    <p>{{ t('notice.body2') }}</p>
    <p>{{ t('notice.body3') }}</p>
    <button type="button" class="dismiss" @click="dismiss">{{ t('notice.dismiss') }}</button>
  </section>
</template>

<style scoped>
.notice {
  background: var(--verdict-caution-bg);
  border: 1px solid var(--verdict-caution-bd);
  color: var(--verdict-caution-fg);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notice-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
}

.notice p {
  font-size: 0.82rem;
  line-height: 1.55;
  margin: 0;
  text-wrap: pretty;
}

.dismiss {
  align-self: flex-start;
  margin-top: 4px;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  color: inherit;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid var(--verdict-caution-bd);
  border-radius: 999px;
  padding: 6px 16px;
  cursor: pointer;
}
</style>
