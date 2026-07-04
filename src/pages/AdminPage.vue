<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useStatusStore } from '@/stores/status'
import { fetchRuleChangeLog, saveRules } from '@/lib/api'
import { computeStatus } from '@/lib/tide'
import { fmtDateTime } from '@/lib/format'
import type { RuleChangeLogEntry } from '@/lib/types'

const { t, locale } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const store = useStatusStore()
const { readings, predictions, rules, status, now } = storeToRefs(store)

const form = reactive({
  safeMaxCm: 0,
  cautionMaxCm: 0,
  crossingMinutes: 0,
  bufferMinutes: 0,
  minWindowMinutes: 0,
})

const saved = ref(false)
const saveError = ref<string | null>(null)
const busy = ref(false)
const log = ref<RuleChangeLogEntry[]>([])

watch(
  rules,
  (r) => {
    if (r) {
      form.safeMaxCm = r.safeMaxCm
      form.cautionMaxCm = r.cautionMaxCm
      form.crossingMinutes = r.crossingMinutes
      form.bufferMinutes = r.bufferMinutes
      form.minWindowMinutes = r.minWindowMinutes
    }
  },
  { immediate: true },
)

const invalid = computed(() => form.cautionMaxCm < form.safeMaxCm)

/** What the public page would show right now with the edited (unsaved) values. */
const preview = computed(() => {
  if (readings.value.length === 0 && predictions.value.length === 0) return null
  return computeStatus(readings.value, predictions.value, { ...form }, now.value)
})

const previewTitleKey = {
  safe: 'verdict.safeTitle',
  caution: 'verdict.cautionTitle',
  unsafe: 'verdict.unsafeTitle',
  unknown: 'verdict.unknownTitle',
} as const

const health = computed(() => {
  const lastReading = status.value?.lastObservedAt ?? null
  const lastPrediction = predictions.value.length
    ? Date.parse(predictions.value[predictions.value.length - 1].predictedAt)
    : null
  return {
    lastReading,
    lastPrediction,
    fresh: status.value?.dataFresh ?? false,
    surge: status.value?.surgeOffsetCm ?? 0,
  }
})

async function save(): Promise<void> {
  if (invalid.value) return
  busy.value = true
  saveError.value = null
  saved.value = false
  try {
    await saveRules({ ...form })
    saved.value = true
    await store.refresh()
    log.value = await fetchRuleChangeLog()
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function signOut(): Promise<void> {
  await auth.signOut()
  await router.push('/')
}

function diff(entry: RuleChangeLogEntry): string {
  const keys = ['safe_max_cm', 'caution_max_cm', 'crossing_minutes', 'buffer_minutes', 'min_window_minutes']
  return keys
    .filter((k) => entry.oldValues[k] !== entry.newValues[k])
    .map((k) => `${k}: ${entry.oldValues[k]} → ${entry.newValues[k]}`)
    .join(', ')
}

onMounted(async () => {
  store.start()
  await auth.init()
  if (auth.isAdmin) {
    try {
      log.value = await fetchRuleChangeLog()
    } catch {
      // change log is admin-only; ignore if RLS denies
    }
  }
})
</script>

<template>
  <div class="page">
    <header class="top">
      <h1>{{ t('admin.title') }}</h1>
      <div class="actions">
        <RouterLink to="/" class="muted">{{ t('admin.backToSite') }}</RouterLink>
        <button class="btn btn-ghost" type="button" @click="signOut">
          {{ t('admin.signOut') }}
        </button>
      </div>
    </header>

    <p v-if="!auth.isAdmin" class="card notadmin">{{ t('login.notAdmin') }}</p>

    <template v-else>
      <!-- Thresholds -->
      <section class="card">
        <h2>{{ t('admin.rules.title') }}</h2>
        <p class="secondary intro">{{ t('admin.rules.intro') }}</p>

        <div class="field">
          <label for="safeMax">{{ t('admin.rules.safeMax') }}: <strong>{{ form.safeMaxCm }}</strong></label>
          <input id="safeMax" v-model.number="form.safeMaxCm" type="range" min="-100" max="200" step="5" />
          <p class="muted">{{ t('admin.rules.safeMaxHelp') }}</p>
        </div>

        <div class="field">
          <label for="cautionMax">{{ t('admin.rules.cautionMax') }}: <strong>{{ form.cautionMaxCm }}</strong></label>
          <input id="cautionMax" v-model.number="form.cautionMaxCm" type="range" min="-100" max="250" step="5" />
          <p class="muted">{{ t('admin.rules.cautionMaxHelp') }}</p>
        </div>

        <div class="field">
          <label for="crossing">{{ t('admin.rules.crossing') }}: <strong>{{ form.crossingMinutes }}</strong></label>
          <input id="crossing" v-model.number="form.crossingMinutes" type="range" min="0" max="90" step="5" />
          <p class="muted">{{ t('admin.rules.crossingHelp') }}</p>
        </div>

        <div class="field">
          <label for="buffer">{{ t('admin.rules.buffer') }}: <strong>{{ form.bufferMinutes }}</strong></label>
          <input id="buffer" v-model.number="form.bufferMinutes" type="range" min="0" max="60" step="5" />
          <p class="muted">{{ t('admin.rules.bufferHelp') }}</p>
        </div>

        <div class="field">
          <label for="minWindow">{{ t('admin.rules.minWindow') }}: <strong>{{ form.minWindowMinutes }}</strong></label>
          <input id="minWindow" v-model.number="form.minWindowMinutes" type="range" min="0" max="240" step="15" />
          <p class="muted">{{ t('admin.rules.minWindowHelp') }}</p>
        </div>

        <p v-if="invalid" class="error">{{ t('admin.rules.invalid') }}</p>

        <div v-if="preview" class="preview" :class="preview.state">
          {{ t('admin.rules.previewState', { state: t(previewTitleKey[preview.state]) }) }}
        </div>

        <div class="save-row">
          <button class="btn" type="button" :disabled="busy || invalid" @click="save">
            {{ t('admin.rules.save') }}
          </button>
          <span v-if="saved" class="saved">✓ {{ t('admin.rules.saved') }}</span>
          <span v-if="saveError" class="error">{{ saveError }}</span>
        </div>
      </section>

      <!-- Data health -->
      <section class="card">
        <h2>{{ t('admin.health.title') }}</h2>
        <table>
          <tbody>
            <tr>
              <th>{{ t('admin.health.lastReading') }}</th>
              <td>
                <template v-if="health.lastReading">
                  {{ fmtDateTime(health.lastReading, locale) }}
                  <strong :class="health.fresh ? 'ok' : 'stale'">
                    {{ health.fresh ? t('admin.health.ok') : t('admin.health.stale') }}
                  </strong>
                </template>
                <template v-else>{{ t('admin.health.noData') }}</template>
              </td>
            </tr>
            <tr>
              <th>{{ t('admin.health.lastPrediction') }}</th>
              <td>
                {{ health.lastPrediction ? fmtDateTime(health.lastPrediction, locale) : t('admin.health.noData') }}
              </td>
            </tr>
            <tr>
              <th>{{ t('admin.health.surge') }}</th>
              <td>{{ health.surge > 0 ? '+' : '' }}{{ health.surge }} cm</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">{{ t('admin.health.surgeHelp') }}</p>
      </section>

      <!-- Change log -->
      <section class="card">
        <h2>{{ t('admin.log.title') }}</h2>
        <p v-if="log.length === 0" class="muted">{{ t('admin.log.empty') }}</p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ t('admin.log.when') }}</th>
                <th>{{ t('admin.log.who') }}</th>
                <th>{{ t('admin.log.change') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in log" :key="entry.id">
                <td>{{ fmtDateTime(Date.parse(entry.changedAt), locale) }}</td>
                <td>{{ entry.changedByEmail ?? '—' }}</td>
                <td>{{ diff(entry) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.top h1 {
  font-size: 1.3rem;
  margin: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.notadmin {
  color: var(--verdict-unsafe-fg);
}

.intro {
  font-size: 0.9rem;
}

.field {
  margin-bottom: 18px;
}

.field label {
  display: block;
  font-size: 0.92rem;
  margin-bottom: 4px;
}

.field input[type='range'] {
  width: 100%;
  padding: 0;
  border: none;
  accent-color: var(--accent);
}

.field .muted {
  margin-top: 4px;
}

.error {
  color: var(--verdict-unsafe-fg);
  font-size: 0.9rem;
}

.preview {
  border-radius: 12px;
  padding: 10px 14px;
  font-weight: 600;
  margin-bottom: 14px;
  border: 1px solid;
}

.preview.safe {
  background: var(--verdict-safe-bg);
  border-color: var(--verdict-safe-bd);
  color: var(--verdict-safe-fg);
}

.preview.caution {
  background: var(--verdict-caution-bg);
  border-color: var(--verdict-caution-bd);
  color: var(--verdict-caution-fg);
}

.preview.unsafe {
  background: var(--verdict-unsafe-bg);
  border-color: var(--verdict-unsafe-bd);
  color: var(--verdict-unsafe-fg);
}

.preview.unknown {
  background: var(--verdict-unknown-bg);
  border-color: var(--verdict-unknown-bd);
  color: var(--verdict-unknown-fg);
}

.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.saved {
  color: var(--verdict-safe-accent);
  font-weight: 600;
}

.ok {
  color: var(--verdict-safe-accent);
  margin-left: 8px;
}

.stale {
  color: var(--verdict-unsafe-accent);
  margin-left: 8px;
}

.table-wrap {
  overflow-x: auto;
}
</style>
