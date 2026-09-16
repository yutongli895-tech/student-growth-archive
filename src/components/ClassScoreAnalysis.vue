<template>
  <div class="sa">
    <!-- ============ 加载中 ============ -->
    <div v-if="loading" class="sa-skel" aria-busy="true" aria-live="polite">
      <p class="sr-only">正在加载学科成绩分析…</p>
      <div class="sk-tiles"><i v-for="n in 4" :key="n" class="sk-tile"></i></div>
      <div class="sk-chart"></div>
      <div class="sk-chart"></div>
    </div>

    <!-- ============ 出错 ============ -->
    <div v-else-if="error" class="msg err">{{ error }}</div>

    <!-- ============ 空态 ============ -->
    <div v-else-if="!hasData" class="empty-state">
      <div class="empty-icon">📊</div>
      <p>还没有成绩数据，暂时无法分析</p>
      <p class="sub">
        可在「学生档案 → 添加成绩」逐条录入，或到「管理 → 成绩导入」按
        <code>学号, 考试名称, 科目, 分数</code> 批量导入
      </p>
    </div>

    <template v-else>
      <!-- ============ 摘要指标 ============ -->
      <div class="kpi-row">
        <div class="kpi">
          <div class="kpi-num">{{ subjects.length }}<span class="kpi-unit">科</span></div>
          <div class="kpi-label">覆盖科目</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">{{ recordCount }}<span class="kpi-unit">条</span></div>
          <div class="kpi-label">成绩记录</div>
        </div>
        <div class="kpi">
          <template v-if="best">
            <div class="kpi-num kpi-subject">{{ best.subject }}</div>
            <div class="kpi-label">平均分最高 · {{ best.avg }}</div>
          </template>
          <template v-else>
            <div class="kpi-num">—</div>
            <div class="kpi-label">平均分最高</div>
          </template>
        </div>
        <div class="kpi" :class="{ alert: poorTotal > 0 }">
          <div class="kpi-num">{{ poorTotal }}<span class="kpi-unit">人次</span></div>
          <div class="kpi-label">低于及格线（{{ thresholds.pass }} 分）</div>
        </div>
      </div>

      <!-- ============ ① 各学科平均分对比 ============ -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>各学科平均分对比</h3>
            <p class="panel-sub">只看有成绩的科目；括号内为该科目的成绩条数，条数少时平均值波动大，请结合人数判断</p>
          </div>
        </div>
        <div class="band-legend">
          <span v-for="b in BANDS" :key="b.key" class="band-item">
            <i :style="{ background: b.color }"></i>{{ b.label }}
          </span>
        </div>
        <div ref="elAvg" class="chart-box" :style="{ height: avgHeight }"
             role="img" :aria-label="avgAria"></div>
      </section>

      <!-- ============ ② 各学科成绩趋势 ============ -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>各学科成绩趋势</h3>
            <p class="panel-sub">纵轴为班级平均分。仅 1 人参加的考试会把均分拉成一条假曲线，默认已隐去</p>
          </div>
          <label class="field">
            <span>考试范围</span>
            <select v-model.number="minStudents" class="select select-sm">
              <option :value="1">全部考试</option>
              <option :value="2">参与 ≥ 2 人</option>
              <option :value="3">参与 ≥ 3 人</option>
              <option :value="5">参与 ≥ 5 人</option>
              <option :value="10">参与 ≥ 10 人</option>
            </select>
          </label>
        </div>
        <div v-if="!trendExams.length" class="hint">
          没有满足「参与 ≥ {{ minStudents }} 人」的考试，把筛选放宽试试
        </div>
        <div v-else ref="elTrend" class="chart-box" :style="{ height: trendHeight }"
             role="img" aria-label="各学科历次考试的平均分折线图"></div>
      </section>

      <!-- ============ ③ 成绩分布 ============ -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>成绩分布</h3>
            <p class="panel-sub">
              按成绩条数统计（同一学生考多次会计多次），不是人数；条形总长即为该科目的成绩条数
            </p>
          </div>
        </div>
        <div class="band-legend">
          <span v-for="b in BANDS" :key="b.key" class="band-item">
            <i :style="{ background: b.color }"></i>{{ b.label }}
          </span>
        </div>
        <div ref="elDist" class="chart-box" :style="{ height: distHeight }"
             role="img" aria-label="各学科各分数段成绩条数的堆叠条形图"></div>
      </section>

      <!-- ============ ④ 明细表（图表的等价文字版，也是无障碍替代） ============ -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>学科明细</h3>
            <p class="panel-sub">「参与人数」为有该科成绩的学生数，分母是班级 {{ scope.studentCount }} 人</p>
          </div>
        </div>
        <div class="tbl-scroll">
          <table class="tbl">
            <thead>
              <tr>
                <th>科目</th>
                <th class="num">参与人数</th>
                <th class="num">成绩条数</th>
                <th class="num">平均分</th>
                <th class="num">最高</th>
                <th class="num">最低</th>
                <th class="num">及格率</th>
                <th class="num">优秀率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in subjects" :key="s.subject">
                <td class="subject">{{ s.subject }}</td>
                <td class="num">
                  {{ s.students }}
                  <span v-if="scope.studentCount" class="muted">/ {{ scope.studentCount }}</span>
                </td>
                <td class="num">{{ s.records }}</td>
                <td class="num">
                  <strong :style="{ color: bandColorOf(s.avg) }">{{ fmt(s.avg) }}</strong>
                </td>
                <td class="num muted">{{ s.max }}</td>
                <td class="num muted">{{ s.min }}</td>
                <td class="num" :class="{ low: s.passRate < 0.9 }">{{ pct(s.passRate) }}</td>
                <td class="num">{{ pct(s.excellentRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="note">
          及格率 = 分数 ≥ {{ thresholds.pass }} 的条数占比；优秀率 = 分数 ≥ {{ thresholds.excellent }} 的条数占比。
        </p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import echarts from '../utils/echarts.js'
import {
  BANDS, DEFAULT_THRESHOLDS,
  bandColor, fmtPct, filterExams, avgSummary,
  buildAvgOption, buildTrendOption, buildDistOption
} from '../utils/scoreCharts.js'

const props = defineProps({
  // handleGetSubjectAnalysis 的返回体：{ scope, thresholds, exams, subjects, recordCount }
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
})

const elAvg = ref(null)
const elTrend = ref(null)
const elDist = ref(null)
let cAvg = null, cTrend = null, cDist = null

const thresholds = computed(() => props.data?.thresholds || DEFAULT_THRESHOLDS)
const scope = computed(() => props.data?.scope || { class: null, label: '—', studentCount: 0 })
const subjects = computed(() => props.data?.subjects || [])
const recordCount = computed(() => props.data?.recordCount || 0)
const hasData = computed(() => subjects.value.length > 0)

const best = computed(() => subjects.value[0] || null)
const poorTotal = computed(() => subjects.value.reduce((a, s) => a + (s.dist?.poor || 0), 0))

const fmt = v => (v === null || v === undefined ? '—' : String(v))
const pct = fmtPct
const bandColorOf = avg => bandColor(avg, thresholds.value)

// —— 考试筛选：只有趋势图受它影响，所以控件放在趋势图自己的标题栏里 ——
const minStudents = ref(2)
const trendExams = computed(() => filterExams(props.data?.exams || [], minStudents.value))

// 图表高度：科目多就把画布放高，避免 x 轴文字挤成一片
const avgHeight = computed(() => `${Math.max(260, Math.min(420, subjects.value.length * 52 + 120))}px`)
const distHeight = computed(() => `${Math.max(160, subjects.value.length * 40 + 90)}px`)
const trendHeight = '300px'

// 纯文本摘要，供屏幕阅读器（图表是 canvas，读不出内容）
const avgAria = computed(() => avgSummary(subjects.value))

// ================= 渲染 =================
function renderAvg() {
  if (cAvg) cAvg.setOption(buildAvgOption({
    subjects: subjects.value,
    thresholds: thresholds.value,
    studentCount: scope.value.studentCount
  }), true)
}

function renderTrend() {
  if (cTrend) cTrend.setOption(buildTrendOption({
    subjects: subjects.value,
    exams: trendExams.value,
    thresholds: thresholds.value
  }), true)
}

function renderDist() {
  if (cDist) cDist.setOption(buildDistOption({ subjects: subjects.value }), true)
}

// ================= 生命周期 =================
// ECharts 实例与 DOM 元素是硬绑定关系。趋势卡片在「没有满足筛选条件的考试」时
// 会切成一段提示文案（v-if），原 DOM 被替换掉；若此时沿用旧实例，图表会画在一个
// 已经脱离文档的节点上——表现为「把筛选放宽了，图还是不出来」。
// 所以每次渲染前都用 getDom() 核对一次实例是否还对得上当前的元素。
function ensure(elRef, inst) {
  const dom = elRef.value
  if (!dom) {
    if (inst) inst.dispose()
    return null
  }
  if (inst && inst.getDom() !== dom) {
    inst.dispose()
    inst = null
  }
  return inst || echarts.init(dom)
}

function renderAll() {
  nextTick(() => {
    if (!hasData.value) {
      disposeAll()
      return
    }
    cAvg = ensure(elAvg, cAvg)
    cTrend = ensure(elTrend, cTrend)
    cDist = ensure(elDist, cDist)

    if (cAvg) renderAvg()
    if (cDist) renderDist()
    if (cTrend) {
      if (trendExams.value.length) renderTrend()
      else cTrend.clear()
    }
  })
}

function disposeAll() {
  for (const c of [cAvg, cTrend, cDist]) c && c.dispose()
  cAvg = cTrend = cDist = null
}

function handleResize() {
  cAvg && cAvg.resize()
  cTrend && cTrend.resize()
  cDist && cDist.resize()
}

onMounted(() => {
  renderAll()
  window.addEventListener('resize', handleResize)
})

watch(() => props.data, () => renderAll(), { deep: true })
watch(minStudents, () => renderAll())

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  disposeAll()
})
</script>

<style scoped>
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---------- 摘要指标 ---------- */
.kpi-row {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 12px; margin-bottom: 16px;
}
.kpi {
  background: var(--bg); border: 1px solid var(--line);
  border-radius: var(--radius-sm); padding: 12px 14px;
}
.kpi.alert { background: var(--danger-light); border-color: rgba(192, 57, 43, .22); }
.kpi-num {
  font-size: 22px; font-weight: 700; line-height: 1.2;
  color: var(--primary); font-variant-numeric: tabular-nums;
}
.kpi.alert .kpi-num { color: var(--danger); }
.kpi-subject { font-size: 18px; }
.kpi-unit { font-size: 12px; font-weight: 600; margin-left: 2px; }
.kpi-label { font-size: 12px; color: var(--muted); margin-top: 2px; }

/* ---------- 面板 ---------- */
.panel {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 16px; margin-bottom: 16px;
}
.panel-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; margin-bottom: 8px;
}
.panel-head h3 { font-size: 14px; font-weight: 600; color: var(--text); }
.panel-sub { font-size: 12px; color: var(--muted); margin-top: 3px; max-width: 62ch; }
.field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.select-sm { padding: 5px 8px; font-size: 12px; }

/* ---------- 分数档图例 ---------- */
.band-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 4px 0 8px; }
.band-item { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
.band-item i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

.chart-box { width: 100%; }
.hint {
  padding: 24px 12px; text-align: center; font-size: 13px;
  color: var(--muted); background: var(--bg);
  border: 1px dashed var(--line); border-radius: var(--radius-sm);
}

/* ---------- 明细表 ---------- */
.tbl-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef1f5; white-space: nowrap; }
.tbl th { color: var(--muted); font-weight: 600; }
.tbl td.num, .tbl th.num { text-align: right; font-variant-numeric: tabular-nums; }
.tbl td.subject { font-weight: 600; }
.tbl .muted { color: var(--muted); font-weight: 400; }
.tbl .low { color: var(--warn); }
.note { font-size: 12px; color: var(--muted); margin-top: 8px; }
code { background: var(--bg); border-radius: 4px; padding: 1px 5px; font-size: 12px; }

/* ---------- 空态 / 提示 ---------- */
.empty-state { text-align: center; padding: 36px 16px; color: var(--muted); }
.empty-icon { font-size: 34px; opacity: .5; margin-bottom: 8px; }
.empty-state p { font-size: 14px; }
.empty-state .sub { font-size: 12px; margin-top: 4px; }
.msg { padding: 10px 16px; border-radius: var(--radius-sm); font-size: 14px; }
.msg.err { background: var(--danger-light); color: var(--danger); }

/* ---------- 加载骨架 ---------- */
.sa-skel { position: relative; }
.sk-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.sk-tile, .sk-chart {
  background: linear-gradient(90deg, #eef1f5 25%, #f6f8fa 37%, #eef1f5 63%);
  background-size: 400% 100%;
  animation: sk 1.4s ease infinite;
  border-radius: var(--radius-sm);
}
.sk-tile { height: 68px; }
.sk-chart { height: 240px; margin-bottom: 16px; }
@keyframes sk { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@media (prefers-reduced-motion: reduce) { .sk-tile, .sk-chart { animation: none; } }

/* ---------- 响应式 ---------- */
@media (max-width: 768px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
  .sk-tiles { grid-template-columns: repeat(2, 1fr); }
  .panel { padding: 14px 12px; }
  .panel-head { flex-direction: column; align-items: flex-start; }
}
</style>
