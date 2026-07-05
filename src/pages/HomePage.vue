<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useStatusStore } from '@/stores/status'
import { useAuthStore } from '@/stores/auth'
import { isDemoMode } from '@/lib/supabase'
import StatusHero from '@/components/StatusHero.vue'
import StickyVerdict from '@/components/StickyVerdict.vue'
import ReturnBanner from '@/components/ReturnBanner.vue'
import RoadCrossSection from '@/components/RoadCrossSection.vue'
import WindowsList from '@/components/WindowsList.vue'
import DiveDeeper from '@/components/DiveDeeper.vue'
import AdminPreviewBar from '@/components/AdminPreviewBar.vue'
import StationSelector from '@/components/StationSelector.vue'
import LangSwitcher from '@/components/LangSwitcher.vue'

const { t } = useI18n()
const store = useStatusStore()
const { status, rules, loading, error, now, extended } = storeToRefs(store)

// Admins get a page-wide time-travel bar to preview how every panel looks at
// a future moment. Non-admins never see it.
const auth = useAuthStore()
const { isAdmin } = storeToRefs(auth)

// Show the sticky verdict bar once the main verdict panel is scrolled past.
const stuck = ref(false)
const heroSentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

watch(heroSentinel, (el) => {
  observer?.disconnect()
  observer = null
  if (el) {
    observer = new IntersectionObserver(([entry]) => {
      stuck.value = entry.boundingClientRect.top < 0
    })
    observer.observe(el)
  }
})

onMounted(() => {
  store.start()
  void auth.init()
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="page">
    <AdminPreviewBar v-if="isAdmin" />

    <header class="top">
      <div>
        <span class="brand">{{ t('app.title') }}</span>
        <span class="sub">{{ t('app.subtitle') }}</span>
      </div>
      <LangSwitcher />
    </header>

    <p v-if="isDemoMode" class="demo-banner">{{ t('demo.banner') }}</p>

    <StationSelector />

    <div v-if="loading" class="card skeleton" aria-busy="true"></div>

    <template v-else-if="status && rules">
      <StickyVerdict :status="status" :now="now" :visible="stuck" />
      <StatusHero :status="status" :rules="rules" :now="now" />
      <div ref="heroSentinel" class="hero-sentinel" aria-hidden="true"></div>
      <ReturnBanner :status="status" :now="now" />
      <RoadCrossSection :status="status" :rules="rules" :now="now" />
      <WindowsList
        :windows="status.windows"
        :now="now"
        :extended="extended"
        @toggle-extended="store.toggleExtended"
      />
      <DiveDeeper :status="status" :rules="rules" :now="now" />
    </template>

    <p v-if="error" class="card error">{{ t('verdict.unknownSub') }}</p>

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

.hero-sentinel {
  height: 1px;
  margin-top: -1px;
}

.demo-banner {
  background: var(--verdict-caution-accent);
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
  color: var(--verdict-unsafe-fg);
}

footer {
  margin-top: 24px;
}

footer .muted {
  margin-bottom: 6px;
}
</style>
