<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { STATIONS, stationName } from '@/lib/stations'
import { useStatusStore } from '@/stores/status'

const { t } = useI18n()
const store = useStatusStore()
const { selectedStationIds, selectedStations, primaryStationId } = storeToRefs(store)

// Toggle a station on/off; never allow zero selected.
function toggle(id: string): void {
  const set = new Set(selectedStationIds.value)
  if (set.has(id)) {
    if (set.size > 1) set.delete(id)
  } else {
    set.add(id)
  }
  store.setSelectedStations([...set])
}
</script>

<template>
  <section class="stations">
    <span class="label">{{ t('stations.label') }}</span>
    <div class="chips">
      <button
        v-for="s in STATIONS"
        :key="s.id"
        type="button"
        class="chip"
        :class="{ on: selectedStationIds.includes(s.id) }"
        :aria-pressed="selectedStationIds.includes(s.id)"
        @click="toggle(s.id)"
      >
        {{ s.name }}
      </button>
    </div>

    <template v-if="selectedStations.length > 1">
      <div class="compare">
        <span v-for="c in selectedStations" :key="c.id" class="cmp" :class="{ primary: c.primary }">
          <span class="cmp-name">{{ c.name }}</span>
          <span class="cmp-level mono">
            {{ c.status && c.status.currentLevelCm !== null ? c.status.currentLevelCm : '—' }} {{ t('chart.unit') }}
            <template v-if="c.status && c.status.rising !== null">{{ c.status.rising ? '↑' : '↓' }}</template>
          </span>
        </span>
      </div>
      <p class="basedon">{{ t('stations.basedOn', { name: stationName(primaryStationId) }) }}</p>
    </template>
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
  color: #fff;
}

.compare {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.cmp {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.cmp.primary {
  font-weight: 700;
  color: var(--text-primary);
}

.cmp-level {
  font-weight: 600;
}

.basedon {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin: 0;
}
</style>
