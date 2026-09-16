/**
 * 学科成绩分析的图表配置（纯函数，无 Vue / 无 DOM 依赖）
 *
 * 为什么要单独成一个模块：
 *   1. 分数分档阈值（85 / 70 / 60）是**业务规则**，必须单点定义，
 *      不能让「平均分图的颜色」「分布图的分段」「明细表的及格率」各写一份。
 *   2. 抽成纯函数就能被单测覆盖，也能在 Node 里用 ECharts SSR 真正渲染出来，
 *      验证配置合法（例如柱状图的 markLine 忘了注册组件时会被静默丢弃）。
 *
 * 消费方：src/components/ClassScoreAnalysis.vue
 */

// 分数档次：全站统一「档次 = 颜色」，平均分图与分布图共用同一套含义。
// 这样教师扫一眼就知道哪个科目落在哪个档，不必来回看图例。
// 颜色取自 src/styles/main.css 的语义令牌（已按 WCAG AA 校准）。
export const BANDS = [
  { key: 'excellent', color: '#2f7d6e', label: '优秀（≥ 85）', short: '优秀' },
  { key: 'good', color: '#2f6bc4', label: '良好（70 – 84）', short: '良好' },
  { key: 'pass', color: '#b45309', label: '及格（60 – 69）', short: '及格' },
  { key: 'poor', color: '#c0392b', label: '待提升（< 60）', short: '待提升' }
]
export const BAND_KEYS = ['excellent', 'good', 'pass', 'poor']

// 与 main.css 对应的画布内颜色（canvas 读不到 CSS 变量，只能在这里写死并保持同步）
export const AXIS_MUTED = '#6b7686'
export const AXIS_LINE = '#e8ecf1'
export const AXIS_TEXT = '#2c3e50'

export const DEFAULT_THRESHOLDS = { pass: 60, good: 70, excellent: 85 }

/** 平均分落在哪个档（边界含等号：正好 85 算优秀） */
export function bandOf(avg, thresholds = DEFAULT_THRESHOLDS) {
  if (avg === null || avg === undefined) return 'pass'
  if (avg >= thresholds.excellent) return 'excellent'
  if (avg >= thresholds.good) return 'good'
  if (avg >= thresholds.pass) return 'pass'
  return 'poor'
}

/** 平均分对应的语义色 */
export function bandColor(avg, thresholds = DEFAULT_THRESHOLDS) {
  const k = bandOf(avg, thresholds)
  const b = BANDS.find(x => x.key === k)
  return (b || BANDS[2]).color
}

export const fmtScore = v => (v === null || v === undefined ? '—' : String(v))
export const fmtPct = v => (v === null || v === undefined ? '—' : Math.round(v * 100) + '%')

/**
 * 按「最少参与人数」筛选考试。
 * 只让 1 个人参加的考试会把班级均分画成一条假曲线（某位学生的个人分），
 * 所以默认门槛是 2，教师可以自己放宽。
 */
export function filterExams(exams = [], minStudents = 2) {
  const min = Number(minStudents) || 1
  return exams.filter(e => (e.students || 0) >= min)
}

function baseAxis(axisLabelColor = AXIS_MUTED) {
  return {
    axisLabel: { color: axisLabelColor, fontSize: 12 },
    axisLine: { lineStyle: { color: AXIS_LINE } },
    axisTick: { show: false }
  }
}

/** ① 各学科平均分对比：柱状图 + 及格线 / 优秀线参考线 */
export function buildAvgOption({ subjects = [], thresholds = DEFAULT_THRESHOLDS, studentCount = 0 }) {
  const names = subjects.map(s => s.subject)
  return {
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const s = subjects[ps[0].dataIndex]
        if (!s) return ''
        const cover = studentCount ? `${s.students} / ${studentCount} 人` : `${s.students} 人`
        return [
          `<b>${s.subject}</b>`,
          `平均分：<b>${s.avg}</b>`,
          `覆盖学生：${cover}`,
          `成绩条数：${s.records}`,
          `最高 ${s.max} · 最低 ${s.min}`,
          `及格率 ${fmtPct(s.passRate)} · 优秀率 ${fmtPct(s.excellentRate)}`
        ].join('<br/>')
      }
    },
    // 柱状图必须从 0 起：截断纵轴会把「85 和 88」的差距放大成错觉
    grid: { left: 44, right: 18, top: 26, bottom: 34, containLabel: false },
    xAxis: { type: 'category', data: names, ...baseAxis(AXIS_TEXT) },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      interval: 20,
      splitLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: AXIS_MUTED, fontSize: 12 }
    },
    series: [{
      type: 'bar',
      barMaxWidth: 46,
      data: subjects.map(s => ({
        value: s.avg,
        itemStyle: { color: bandColor(s.avg, thresholds), borderRadius: [6, 6, 0, 0] }
      })),
      label: { show: true, position: 'top', color: AXIS_TEXT, fontSize: 12, fontWeight: 600 },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { color: AXIS_MUTED, fontSize: 11, formatter: p => p.name },
        data: [
          { yAxis: thresholds.excellent, name: `优秀线 ${thresholds.excellent}`, lineStyle: { color: '#2f7d6e', type: 'dashed', width: 1 } },
          { yAxis: thresholds.pass, name: `及格线 ${thresholds.pass}`, lineStyle: { color: '#c0392b', type: 'dashed', width: 1 } }
        ]
      }
    }]
  }
}

/** ② 各学科成绩趋势：多折线，x 轴为考试 */
export function buildTrendOption({ subjects = [], exams = [], thresholds = DEFAULT_THRESHOLDS }) {
  const names = exams.map(e => (typeof e === 'string' ? e : e.exam))
  const series = subjects.map((s, idx) => {
    const byExam = new Map((s.byExam || []).map(p => [p.exam, p]))
    return {
      name: s.subject,
      type: 'line',
      smooth: true,
      // 某科缺考某场考试时该点为 null；connectNulls 让折线跨过缺口继续画，
      // 否则一门课缺一次就被断成两截，趋势看不出来。
      connectNulls: true,
      symbolSize: 7,
      data: names.map(n => {
        const p = byExam.get(n)
        return p ? p.avg : null
      }),
      itemStyle: { color: bandColor(s.avg, thresholds) },
      lineStyle: { width: 2 },
      // markLine 是「序列级」配置，挂到每条序列上会重复画；只挂第一条
      markLine: idx === 0
        ? {
            silent: true,
            symbol: 'none',
            label: { color: AXIS_MUTED, fontSize: 11, formatter: `及格线 ${thresholds.pass}` },
            lineStyle: { color: '#c0392b', type: 'dashed', width: 1 },
            data: [{ yAxis: thresholds.pass }]
          }
        : undefined
    }
  })
  return {
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (ps) => {
        const head = `<b>${ps[0].axisValue}</b>`
        const body = ps
          .filter(p => p.value !== null && p.value !== undefined)
          .map(p => `${p.marker}${p.seriesName}：<b>${p.value}</b>`)
        return [head, ...body].join('<br/>')
      }
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: AXIS_MUTED, fontSize: 12 }
    },
    grid: { left: 44, right: 18, top: 24, bottom: 52, containLabel: false },
    xAxis: {
      type: 'category',
      data: names,
      boundaryGap: false,
      ...baseAxis(),
      axisLabel: { color: AXIS_MUTED, fontSize: 12, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      // scale:true 让纵轴不从 0 起。均分集中在 60~95，从 0 起会把趋势压成平线。
      // 折线图不要求零基线（柱状图才要求，见 buildAvgOption 的 min:0）。
      scale: true,
      splitLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: AXIS_MUTED, fontSize: 12 }
    },
    series
  }
}

/** ③ 成绩分布：横向堆叠条形图（按成绩条数，不是按人数） */
export function buildDistOption({ subjects = [] }) {
  // 横向条形图的第一项画在最下方，倒序后「平均分最高的科目」出现在最上方
  const rows = [...subjects].reverse()
  return {
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const s = rows[ps[0].dataIndex]
        if (!s) return ''
        const total = BAND_KEYS.reduce((a, k) => a + (s.dist[k] || 0), 0)
        const lines = BAND_KEYS.map(k => {
          const b = BANDS.find(x => x.key === k)
          const n = s.dist[k] || 0
          const p = total ? Math.round((n / total) * 100) : 0
          return `${b.short}：${n} 条（${p}%）`
        })
        return [`<b>${s.subject}</b>　共 ${total} 条`, ...lines].join('<br/>')
      }
    },
    grid: { left: 68, right: 30, top: 10, bottom: 26, containLabel: false },
    xAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: AXIS_MUTED, fontSize: 12 }
    },
    yAxis: { type: 'category', data: rows.map(s => s.subject), ...baseAxis(AXIS_TEXT) },
    series: BAND_KEYS.map(k => {
      const b = BANDS.find(x => x.key === k)
      return {
        name: b.short,
        type: 'bar',
        stack: 'dist',
        barMaxWidth: 26,
        itemStyle: { color: b.color },
        // 段内标数值；0 不标，免得满屏小字
        label: {
          show: true,
          color: '#fff',
          fontSize: 11,
          fontWeight: 600,
          formatter: (p) => (p.value > 0 ? p.value : '')
        },
        data: rows.map(s => s.dist[k] || 0)
      }
    })
  }
}

/** 供屏幕阅读器使用的纯文本摘要（canvas 图表读不出内容） */
export function avgSummary(subjects = []) {
  if (!subjects.length) return '暂无学科成绩'
  return '各学科平均分：' + subjects.map(s => `${s.subject} ${s.avg} 分（${s.records} 条记录）`).join('；')
}
