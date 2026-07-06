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
const { readings, predictions, forecast, rules, status, now, primaryStationName } = storeToRefs(store)

const form = reactive({
  floodMarginCm: 0,
  fallMarginCm: 0,
  cautionMaxCm: 0,
  crossingMinutes: 0,
  bufferMinutes: 0,
  minWindowMinutes: 0,
  windAdjustmentEnabled: true,
  puddleWarningEnabled: false,
  puddleWarningRangeCm: 15,
})

const saved = ref(false)
const saveError = ref<string | null>(null)
const busy = ref(false)
const log = ref<RuleChangeLogEntry[]>([])

// Which build is live — baked in at build time (vite.config.ts). Lets an admin
// confirm on the live site that a deploy actually shipped.
const commitSha = __COMMIT_SHA__
const shortSha = commitSha === 'unknown' ? commitSha : commitSha.slice(0, 7)
const commitUrl =
  commitSha === 'unknown'
    ? null
    : `https://github.com/DavidSGrady/safe-to-go/commit/${commitSha}`
const builtAt = computed(() => {
  const ms = Date.parse(__BUILD_TIME__)
  return Number.isNaN(ms) ? __BUILD_TIME__ : fmtDateTime(ms, locale.value)
})

watch(
  rules,
  (r) => {
    if (r) {
      form.floodMarginCm = r.floodMarginCm
      form.fallMarginCm = r.fallMarginCm
      form.cautionMaxCm = r.cautionMaxCm
      form.crossingMinutes = r.crossingMinutes
      form.bufferMinutes = r.bufferMinutes
      form.minWindowMinutes = r.minWindowMinutes
      form.windAdjustmentEnabled = r.windAdjustmentEnabled
      form.puddleWarningEnabled = r.puddleWarningEnabled
      form.puddleWarningRangeCm = r.puddleWarningRangeCm
    }
  },
  { immediate: true },
)

const invalid = computed(
  () =>
    form.fallMarginCm < 0 ||
    form.fallMarginCm > form.cautionMaxCm ||
    form.floodMarginCm < 0 ||
    form.floodMarginCm > form.cautionMaxCm,
)

/** What the public page would show right now with the edited (unsaved) values. */
const preview = computed(() => {
  if (readings.value.length === 0 && predictions.value.length === 0) return null
  return computeStatus(readings.value, predictions.value, forecast.value, { ...form }, now.value)
})

const previewTitleKey = {
  safe: 'verdict.safeTitle',
  caution: 'verdict.cautionTitle',
  approaching: 'verdict.approachingTitle',
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
  const keys = [
    'flood_margin_cm',
    'fall_margin_cm',
    'caution_max_cm',
    'crossing_minutes',
    'buffer_minutes',
    'min_window_minutes',
    'wind_adjustment_enabled',
    'puddle_warning_enabled',
    'puddle_warning_range_cm',
  ]
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
      <p class="prod-warning">{{ t('admin.prodWarning') }}</p>

      <!-- Thresholds -->
      <section class="card">
        <h2>{{ t('admin.rules.title') }}</h2>
        <p class="secondary intro">{{ t('admin.rules.intro', { station: primaryStationName }) }}</p>

        <div class="field">
          <label for="fallMargin">{{ t('admin.rules.fallMargin') }}: <strong>{{ form.fallMarginCm }}</strong></label>
          <input id="fallMargin" v-model.number="form.fallMarginCm" type="range" min="0" max="30" step="1" />
          <p class="muted">{{ t('admin.rules.fallMarginHelp') }}</p>
        </div>

        <div class="field">
          <label for="cautionMax">{{ t('admin.rules.cautionMax') }}: <strong>{{ form.cautionMaxCm }}</strong></label>
          <input id="cautionMax" v-model.number="form.cautionMaxCm" type="range" min="-100" max="250" step="5" />
          <p class="muted">{{ t('admin.rules.cautionMaxHelp') }}</p>
        </div>

        <div class="field">
          <label for="floodMargin">{{ t('admin.rules.floodMargin') }}: <strong>{{ form.floodMarginCm }}</strong></label>
          <input id="floodMargin" v-model.number="form.floodMarginCm" type="range" min="0" max="30" step="1" />
          <p class="muted">{{ t('admin.rules.floodMarginHelp') }}</p>
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

        <div class="field toggle-field">
          <label class="toggle">
            <input v-model="form.windAdjustmentEnabled" type="checkbox" />
            <span class="toggle-text">
              <span class="toggle-title">{{ t('admin.rules.windAdjust') }}</span>
              <span class="toggle-state">
                {{ form.windAdjustmentEnabled ? t('admin.rules.windAdjustOn') : t('admin.rules.windAdjustOff') }}
              </span>
            </span>
          </label>
          <p class="muted">{{ t('admin.rules.windAdjustHelp') }}</p>
        </div>

        <div class="field toggle-field">
          <label class="toggle">
            <input v-model="form.puddleWarningEnabled" type="checkbox" />
            <span class="toggle-text">
              <span class="toggle-title">{{ t('admin.rules.puddleToggle') }}</span>
              <span class="toggle-state">
                {{ form.puddleWarningEnabled ? t('admin.rules.puddleOn') : t('admin.rules.puddleOff') }}
              </span>
            </span>
          </label>
          <p class="muted">{{ t('admin.rules.puddleHelp') }}</p>
        </div>

        <div v-if="form.puddleWarningEnabled" class="field">
          <label for="puddleRange">{{ t('admin.rules.puddleRange') }}: <strong>{{ form.puddleWarningRangeCm }}</strong></label>
          <input id="puddleRange" v-model.number="form.puddleWarningRangeCm" type="range" min="0" max="40" step="1" />
          <p class="muted">{{ t('admin.rules.puddleRangeHelp') }}</p>
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
        <p class="muted">{{ t('admin.health.timePrecisionNote') }}</p>
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

    <p class="build-info muted">
      {{ t('admin.build.label') }}
      <a v-if="commitUrl" :href="commitUrl" target="_blank" rel="noopener" class="mono">{{ shortSha }}</a>
      <span v-else class="mono">{{ shortSha }}</span>
      · {{ t('admin.build.builtAt', { time: builtAt }) }}
    </p>
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

.prod-warning {
  background: var(--verdict-unsafe-bg);
  border: 1px solid var(--verdict-unsafe-bd);
  color: var(--verdict-unsafe-fg);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 0.85rem;
  font-weight: 600;
  margin: 0 0 16px;
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

.toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.toggle input {
  width: 20px;
  height: 20px;
  flex: none;
  accent-color: var(--accent);
  cursor: pointer;
}

.toggle-text {
  display: flex;
  flex-direction: column;
}

.toggle-title {
  font-size: 0.92rem;
  font-weight: 500;
}

.toggle-state {
  font-size: 0.78rem;
  color: var(--text-muted);
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

.preview.caution,
.preview.approaching {
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

.build-info {
  text-align: center;
  font-size: 0.75rem;
  margin-top: 20px;
}

.build-info a {
  color: var(--text-secondary);
}
</style>
