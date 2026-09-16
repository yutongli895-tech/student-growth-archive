<template>
  <div v-if="!hasData" class="chart-empty">
    <span class="chart-empty-icon">📈</span>
    <p>暂无成绩记录</p>
    <p class="chart-empty-hint">教师可在下方「添加成绩」录入，或到「管理 → 成绩导入」批量导入</p>
  </div>
  <div v-else ref="el" class="chart"></div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import echarts from '../utils/echarts.js'

const props = defineProps({
  scores: { type: Array, default: () => [] }
})
const emit = defineEmits(['exam-click'])
const el = ref(null)
let chart = null

// 语义色顺序固定，保证同一科目在不同图表里颜色一致
const PALETTE = ['#2f7d6e', '#2f6bc4', '#b45309', '#7c5cbf', '#0f8b8d', '#c2410c']
const MUTED = '#6b7686'
const LINE = '#e8ecf1'

const hasData = computed(() => Array.isArray(props.scores) && props.scores.length > 0)

// 从数据里推导科目，避免硬编码（原先固定 数学/英语/语文，其它科目不显示）
// 下划线开头的是辅助字段（_images 附件、_ids 成绩行主键），不是科目 ——
// 用 k.startsWith('_') 而不是逐个列举，免得每加一个辅助字段就要回来改这里
// （漏改的后果是图表里冒出一个叫「_ids」的假科目）。
function deriveSubjects() {
  const set = new Set()
  for (const s of props.scores) {
    for (const k of Object.keys(s)) {
      if (k === 'exam' || k.startsWith('_')) continue
      if (typeof s[k] === 'number') set.add(k)
    }
  }
  return [...set]
}

function render() {
  if (!chart) return
  const exams = props.scores.map(s => s.exam)
  const subjects = deriveSubjects()
  const series = subjects.map((sub, i) => ({
    name: sub,
    type: 'line',
    smooth: true,
    connectNulls: true,
    symbolSize: 6,
    data: props.scores.map(s => (typeof s[sub] === 'number' ? s[sub] : null)),
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    lineStyle: { width: 2 }
  }))
  chart.setOption({
    color: PALETTE,
    tooltip: { trigger: 'axis', confine: true },
    legend: {
      data: subjects,
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: MUTED, fontSize: 12 }
    },
    grid: { left: 40, right: 16, top: 20, bottom: 44 },
    xAxis: {
      type: 'category',
      data: exams,
      boundaryGap: false,
      axisLabel: { color: MUTED, fontSize: 12 },
      axisLine: { lineStyle: { color: LINE } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      min: 40,
      max: 100,
      splitLine: { lineStyle: { color: LINE } },
      axisLabel: { color: MUTED, fontSize: 12 }
    },
    series
  }, true)
}

function handleResize() { chart && chart.resize() }

function ensureChart() {
  if (!hasData.value) {
    // 数据清空时销毁实例，避免留下空画布
    if (chart) { chart.dispose(); chart = null }
    return
  }
  nextTick(() => {
    if (!el.value) return
    if (!chart) chart = echarts.init(el.value)
    render()
  })
}

onMounted(() => {
  ensureChart()
  window.addEventListener('resize', handleResize)
})

// 新增成绩后父组件会重新拉取学生数据，scores 变化时同步刷新图表
watch(() => props.scores, () => ensureChart(), { deep: true })

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  chart && chart.dispose()
  chart = null
})
</script>

<style scoped>
.chart-empty {
  height: 320px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4px;
  color: var(--muted);
}
.chart-empty-icon { font-size: 32px; opacity: .55; }
.chart-empty p { font-size: 14px; }
.chart-empty-hint { font-size: 12px; opacity: .8; text-align: center; max-width: 320px; }
@media (max-width: 768px) { .chart-empty { height: 260px; } }
</style>
