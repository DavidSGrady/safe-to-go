<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocale, type LocaleCode } from '@/i18n'

const { locale } = useI18n()

function onChange(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value as LocaleCode)
}
</script>

<template>
  <label class="lang">
    <span aria-hidden="true">🌐</span>
    <select :value="locale" aria-label="Language" @change="onChange">
      <option v-for="l in SUPPORTED_LOCALES" :key="l.code" :value="l.code">
        {{ l.label }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.lang {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

select {
  width: auto;
  padding: 6px 10px;
  border-radius: 10px;
  font-size: 0.88rem;
  background: var(--surface);
}
</style>
