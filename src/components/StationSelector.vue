<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { STATIONS } from '@/lib/stations'
import { useStatusStore } from '@/stores/status'

const { t } = useI18n()
const store = useStatusStore()
const { selectedStationIds } = storeToRefs(store)

// Exactly one station at a time — picking one replaces the selection.
function select(id: string): void {
  store.setSelectedStations([id])
}
</script>

<template>
  <section class="stations">
    <span class="label">{{ t('stations.label') }}</span>
    <div class="chips" role="radiogroup" :aria-label="t('stations.label')">
      <button
        v-for="s in STATIONS"
        :key="s.id"
        type="button"
        role="radio"
        class="chip"
        :class="{ on: selectedStationIds.includes(s.id) }"
        :aria-checked="selectedStationIds.includes(s.id)"
        @click="select(s.id)"
      >
        {{ s.name }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.stations {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.label {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
