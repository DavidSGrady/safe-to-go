<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const sections = ['what', 'road', 'wind', 'rule'] as const
const icons: Record<(typeof sections)[number], string> = {
  what: '🌊',
  road: '🛞',
  wind: '💨',
  rule: '⚠️',
}
</script>

<template>
  <section class="card">
    <h2>{{ t('explainer.title') }}</h2>
    <div class="grid">
      <div v-for="s in sections" :key="s" class="item">
        <span class="icon" aria-hidden="true">{{ icons[s] }}</span>
        <div>
          <h3>{{ t(`explainer.${s}Title`) }}</h3>
          <p class="secondary">{{ t(`explainer.${s}Body`) }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  gap: 16px;
}

.item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.icon {
  font-size: 1.5rem;
  line-height: 1.3;
}

h3 {
  font-size: 0.98rem;
  margin-bottom: 2px;
}

p {
  font-size: 0.9rem;
  margin: 0;
}

@media (min-width: 560px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
