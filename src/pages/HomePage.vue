<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { isDemoMode } from '@/lib/supabase'
import StatusHero from '@/components/StatusHero.vue'
import NextWindows from '@/components/NextWindows.vue'
import TideChart from '@/components/TideChart.vue'
import TideExplainer from '@/components/TideExplainer.vue'
import LangSwitcher from '@/components/LangSwitcher.vue'

const { t } = useI18n()
const store = useStatusStore()
const { status, rules, loading, error, now } = storeToRefs(store)

onMounted(() => store.start())
</script>

<template>
  <div class="page">
    <header class="top">
      <div>
        <span class="brand">{{ t('app.title') }}</span>
        <span class="sub">{{ t('app.subtitle') }}</span>
      </div>
      <LangSwitcher />
    </header>

    <p v-if="isDemoMode" class="demo-banner">{{ t('demo.banner') }}</p>

    <div v-if="loading" class="card skeleton" aria-busy="true"></div>

    <template v-else-if="status">
      <StatusHero :status="status" :now="now" />
      <NextWindows :windows="status.windows.filter((w) => w.end > now)" :now="now" />

      <section v-if="rules && status.curve.length" class="card">
        <h2>{{ t('chart.title') }}</h2>
        <TideChart :curve="status.curve" :rules="rules" :now="now" />
      </section>

      <TideExplainer />
    </template>

    <p v-if="error" class="card error">{{ t('status.unknownDesc') }}</p>

    <footer>
      <p class="muted">{{ t('footer.disclaimer') }}</p>
      <p class="muted">{{ t('footer.source') }}</p>
      <p class="muted">
        <RouterLink to="/admin">{{ t('footer.admin') }}</RouterLink>
      </p>
    </footer>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.brand {
  display: block;
  font-weight: 800;
  font-size: 1.15rem;
}

.sub {
  display: block;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.demo-banner {
  background: var(--ink-caution);
  color: #fff;
  border-radius: 12px;
  padding: 8px 14px;
  font-size: 0.85rem;
  margin: 0 0 16px;
}

.skeleton {
  height: 260px;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}

.error {
  color: var(--ink-unsafe);
}

footer {
  margin-top: 24px;
}

footer .muted {
  margin-bottom: 6px;
}
</style>
