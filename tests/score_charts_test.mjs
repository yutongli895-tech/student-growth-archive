// 学科成绩分析的图表配置回归测试（I 套件）
//
// 这组测试的价值有两层：
//   1. **业务规则**：85 / 70 / 60 三档的边界（含等号）必须钉死。
//      边界写错（比如把 ≥85 写成 >85）不会报错，只会让 85 分的学生
//      从「优秀」掉到「良好」，是最难被发现的错误之一。
//   2. **图表配置真的能画出来**：用 ECharts 的 SSR 模式把配置渲染成 SVG 再断言内容。
//      这是唯一能验证「按需引入的模块是否齐全」的办法 —— 比如 MarkLineComponent
//      没注册时，参考线会被**静默丢弃**，构建不报错、页面也不报错，只是线不见了。
//
// 运行：node tests/score_charts_test.mjs（或 run_all_tests.mjs 一次性跑全套）

import echarts from '../src/utils/echarts.js'
// SSR 只在测试里用得到：应用本身用 CanvasRenderer（见 src/utils/echarts.js），
// 这里额外注册 SVG 渲染器以便把图表渲染成字符串来断言内容。
// 加在测试文件里不会进产物。
import { SVGRenderer } from 'echarts/renderers'
echarts.use([SVGRenderer])
import {
  BANDS, BAND_KEYS, DEFAULT_THRESHOLDS,
  bandOf, bandColor, filterExams, fmtPct, avgSummary,
  buildAvgOption, buildTrendOption, buildDistOption
} from '../src/utils/scoreCharts.js'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')) }
}

// ---------- 造一份与后端返回体同形的数据 ----------
const T = { pass: 60, good: 70, excellent: 85 }
const subjects = [
  {
    subject: '语文', records: 4, students: 4, avg: 85, max: 90, min: 80,
    dist: { excellent: 3, good: 1, pass: 0, poor: 0 }, passRate: 1, excellentRate: 0.75,
    byExam: [{ exam: '期中', avg: 85, students: 4 }]
  },
  {
    subject: '数学', records: 4, students: 4, avg: 78, max: 95, min: 55,
    dist: { excellent: 2, good: 1, pass: 0, poor: 1 }, passRate: 0.75, excellentRate: 0.5,
    byExam: [{ exam: '期中', avg: 78, students: 4 }]
  },
  {
    subject: '英语', records: 2, students: 2, avg: 65, max: 70, min: 60,
    dist: { excellent: 0, good: 1, pass: 1, poor: 0 }, passRate: 1, excellentRate: 0,
    byExam: [{ exam: '期末', avg: 65, students: 2 }]
  },
  {
    subject: '物理', records: 1, students: 1, avg: 45, max: 45, min: 45,
    dist: { excellent: 0, good: 0, pass: 0, poor: 1 }, passRate: 0, excellentRate: 0,
    byExam: [{ exam: '期末', avg: 45, students: 1 }]
  }
]
const exams = [
  { exam: '期中', records: 8, students: 4, subjects: 2 },
  { exam: '期末', records: 3, students: 2, subjects: 2 }
]

// ============================================================
// 1. 分档阈值与边界
// ============================================================
console.log('\n##### 学科成绩分析：图表配置 #####\n')
console.log('--- 1. 分档阈值（边界含等号） ---')

check('100 分 → 优秀', bandOf(100, T) === 'excellent')
check('85 分（正好等于优秀线）→ 优秀', bandOf(85, T) === 'excellent', bandOf(85, T))
check('84.9 → 良好', bandOf(84.9, T) === 'good', bandOf(84.9, T))
check('70 分（正好等于良好线）→ 良好', bandOf(70, T) === 'good', bandOf(70, T))
check('69.9 → 及格', bandOf(69.9, T) === 'pass', bandOf(69.9, T))
check('60 分（正好等于及格线）→ 及格', bandOf(60, T) === 'pass', bandOf(60, T))
check('59.9 → 待提升', bandOf(59.9, T) === 'poor', bandOf(59.9, T))
check('0 分 → 待提升', bandOf(0, T) === 'poor')
check('null 不炸，归入及格档（占位色）', bandOf(null, T) === 'pass')
check('不传阈值时用默认 85/70/60', bandOf(85) === 'excellent' && bandOf(70) === 'good' && bandOf(60) === 'pass')

check('四档颜色两两不同', new Set(BANDS.map(b => b.color)).size === 4)
check('平均分颜色随档次变化：85 绿 / 78 蓝 / 65 橙 / 45 红',
  bandColor(85, T) !== bandColor(78, T) &&
  bandColor(78, T) !== bandColor(65, T) &&
  bandColor(65, T) !== bandColor(45, T),
  [85, 78, 65, 45].map(v => bandColor(v, T)).join(' '))
check('bandColor 与 BANDS 表一致（平均分图与分布图同色系）',
  bandColor(85, T) === BANDS.find(b => b.key === 'excellent').color &&
  bandColor(45, T) === BANDS.find(b => b.key === 'poor').color)

// ============================================================
// 2. 考试筛选
// ============================================================
console.log('\n--- 2. 考试筛选（零散考试会把均分画成假曲线）---')

check('默认门槛 2：只有 1 人参加的考试被隐去',
  filterExams(exams, 2).map(e => e.exam).join(',') === '期中,期末',
  JSON.stringify(filterExams(exams, 2).map(e => e.exam)))
check('门槛 3：只剩期中', filterExams(exams, 3).map(e => e.exam).join(',') === '期中')
check('门槛 1：全部保留', filterExams(exams, 1).length === 2)
check('空输入不炸', filterExams([], 2).length === 0 && filterExams(undefined, 2).length === 0)
check('保持原有顺序（趋势图的 x 轴不能乱）',
  filterExams(exams, 1).map(e => e.exam).join(',') === '期中,期末')

// ============================================================
// 3. 平均分图配置
// ============================================================
console.log('\n--- 3. 平均分对比图配置 ---')

const avgOpt = buildAvgOption({ subjects, thresholds: T, studentCount: 4 })
check('柱状图纵轴从 0 起（截断纵轴会放大差距，是误导）', avgOpt.yAxis.min === 0, String(avgOpt.yAxis.min))
check('纵轴上限 100', avgOpt.yAxis.max === 100)
check('x 轴为科目名且顺序与入参一致',
  avgOpt.xAxis.data.join(',') === '语文,数学,英语,物理', avgOpt.xAxis.data.join(','))
check('每根柱子带语义色（按平均分所在档）',
  avgOpt.series[0].data[0].itemStyle.color === BANDS[0].color &&
  avgOpt.series[0].data[3].itemStyle.color === BANDS[3].color,
  JSON.stringify(avgOpt.series[0].data.map(d => d.itemStyle.color)))
check('柱顶显示数值', avgOpt.series[0].label.show === true)
check('有两条参考线：优秀线 + 及格线',
  avgOpt.series[0].markLine.data.length === 2 &&
  avgOpt.series[0].markLine.data.some(d => d.yAxis === 85) &&
  avgOpt.series[0].markLine.data.some(d => d.yAxis === 60),
  JSON.stringify(avgOpt.series[0].markLine.data.map(d => d.yAxis)))
check('参考线带文字标签', avgOpt.series[0].markLine.data.every(d => !!d.name))
check('tooltip 展示覆盖人数与班级人数（样本量必须可见）',
  avgOpt.tooltip.formatter([{ dataIndex: 1 }]).includes('4 / 4 人'),
  avgOpt.tooltip.formatter([{ dataIndex: 1 }]))
check('人数未知时不显示分母', buildAvgOption({ subjects, thresholds: T, studentCount: 0 })
  .tooltip.formatter([{ dataIndex: 1 }]).includes('4 人'))
check('tooltip 含及格率与优秀率',
  avgOpt.tooltip.formatter([{ dataIndex: 1 }]).includes('75%'))

// ============================================================
// 4. 趋势图配置
// ============================================================
console.log('\n--- 4. 成绩趋势图配置 ---')

const trendOpt = buildTrendOption({ subjects, exams: filterExams(exams, 2), thresholds: T })
check('每个科目一条折线', trendOpt.series.length === 4, String(trendOpt.series.length))
check('x 轴为筛选后的考试',
  trendOpt.xAxis.data.join(',') === '期中,期末', trendOpt.xAxis.data.join(','))
check('缺考的考试该点为 null（不是 0，也不是漏点）',
  trendOpt.series[1].data[0] === 78 && trendOpt.series[1].data[1] === null,
  JSON.stringify(trendOpt.series[1].data))
check('connectNulls 打开（缺一次考试不能把折线断成两截）',
  trendOpt.series.every(s => s.connectNulls === true))
check('及格线只挂在第一条序列上（挂多了会重复画）',
  trendOpt.series[0].markLine && trendOpt.series.slice(1).every(s => !s.markLine),
  JSON.stringify(trendOpt.series.map(s => !!s.markLine)))
check('及格线数值取自阈值', trendOpt.series[0].markLine.data[0].yAxis === 60)
check('趋势图纵轴不强制零基线（否则均分趋势被压成平线）',
  trendOpt.yAxis.scale === true)
check('图例可滚动（科目多时不挤在一起）', trendOpt.legend.type === 'scroll')
check('tooltip 按考试聚合且跳过空值',
  !trendOpt.tooltip.formatter([{ axisValue: '期末', value: 78, seriesName: '数学', marker: '' },
                               { axisValue: '期末', value: null, seriesName: '语文', marker: '' }])
    .includes('语文'),
  trendOpt.tooltip.formatter([{ axisValue: '期末', value: 78, seriesName: '数学', marker: '' },
                              { axisValue: '期末', value: null, seriesName: '语文', marker: '' }]))

// ============================================================
// 5. 分布图配置
// ============================================================
console.log('\n--- 5. 成绩分布图配置 ---')

const distOpt = buildDistOption({ subjects })
check('四档各一条堆叠序列', distOpt.series.length === 4)
check('四条序列堆在同一组（stack 名一致）',
  new Set(distOpt.series.map(s => s.stack)).size === 1,
  JSON.stringify(distOpt.series.map(s => s.stack)))
check('堆叠顺序：优秀 → 良好 → 及格 → 待提升',
  distOpt.series.map(s => s.name).join(',') === '优秀,良好,及格,待提升',
  distOpt.series.map(s => s.name).join(','))
check('科目倒序，平均分最高的显示在最上',
  distOpt.yAxis.data.join(',') === '物理,英语,数学,语文', distOpt.yAxis.data.join(','))
check('语文的段值为 3/1/0/0',
  distOpt.series.map(s => s.data[3]).join(',') === '3,1,0,0',
  distOpt.series.map(s => s.data[3]).join(','))
check('0 不显示标签（免得满屏小字）',
  distOpt.series[2].label.formatter({ value: 0 }) === '' &&
  distOpt.series[2].label.formatter({ value: 5 }) === 5)
check('tooltip 给出总数与各档占比',
  distOpt.tooltip.formatter([{ dataIndex: 3 }]).includes('共 4 条'),
  distOpt.tooltip.formatter([{ dataIndex: 3 }]))
check('tooltip 占比正确（语文优秀 3/4 = 75%）',
  distOpt.tooltip.formatter([{ dataIndex: 3 }]).includes('75%'),
  distOpt.tooltip.formatter([{ dataIndex: 3 }]))

// ============================================================
// 6. SSR 渲染：配置真的能画出图（也验证按需引入的模块齐全）
// ============================================================
console.log('\n--- 6. SSR 实渲染（兼验按需引入是否齐全）---')

function renderSVG(option, { width = 660, height = 320 } = {}) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  chart.setOption(option)
  const svg = chart.renderToSVGString()
  chart.dispose()
  return svg
}

const svgAvg = renderSVG(avgOpt)
check('平均分图能渲染出 SVG', svgAvg.startsWith('<svg') && svgAvg.length > 2000, `长度 ${svgAvg.length}`)
check('图里出现科目名', ['语文', '数学', '英语', '物理'].every(s => svgAvg.includes(s)),
  '渲染结果里找不到科目名，说明 x 轴没画出来')
check('图里出现柱顶数值', svgAvg.includes('>85<') || svgAvg.includes('85</text>'),
  '柱顶数值标签没渲染')
// MarkLineComponent 忘记注册时参考线会被静默丢弃 —— 构建不报错、页面不报错，线就是没有
check('参考线真的画出来了（MarkLineComponent 已注册）',
  svgAvg.includes('优秀线 85') && svgAvg.includes('及格线 60'),
  '参考线文字缺失 → markLine 组件没注册或被忽略')

const svgTrend = renderSVG(buildTrendOption({ subjects, exams: filterExams(exams, 2), thresholds: T }))
check('趋势图能渲染出 SVG', svgTrend.startsWith('<svg') && svgTrend.length > 2000, `长度 ${svgTrend.length}`)
check('趋势图 x 轴有考试名', svgTrend.includes('期中') && svgTrend.includes('期末'))
check('趋势图图例列出科目（LegendComponent 已注册）',
  ['语文', '数学', '英语', '物理'].every(s => svgTrend.includes(s)))
check('趋势图参考线也画出来了', svgTrend.includes('及格线 60'))

const svgDist = renderSVG(buildDistOption({ subjects }), { height: 260 })
check('分布图能渲染出 SVG', svgDist.startsWith('<svg') && svgDist.length > 2000, `长度 ${svgDist.length}`)
check('分布图渲染出科目名', ['语文', '数学', '英语', '物理'].every(s => svgDist.includes(s)))
// 四档图例是组件模板里的 HTML（.band-legend），**刻意不画进 canvas**：
// HTML 文字可选中、可被屏幕阅读器读出，canvas 里的文字不行。
// 所以这里断言的是「四种语义色都出现在图里」，而不是「图里有四档文字」。
check('四种分档颜色都出现在图里',
  BANDS.every(b => svgDist.includes(b.color.replace('#', '')) || svgDist.includes(b.color)),
  '缺色 → 某条堆叠序列没画出来')
check('分布图堆叠段里有数字标签', /\d<\/text>/.test(svgDist))
check('分布图不带 canvas 内图例（图例走 HTML，便于读屏）', distOpt.legend === undefined)

// 空数据不该炸（真实场景：新建的班还没录成绩）
console.log('\n--- 7. 空数据兜底 ---')
let emptyOk = true, emptyErr = ''
try {
  renderSVG(buildAvgOption({ subjects: [], thresholds: T, studentCount: 0 }), { height: 200 })
  renderSVG(buildTrendOption({ subjects: [], exams: [], thresholds: T }), { height: 200 })
  renderSVG(buildDistOption({ subjects: [] }), { height: 200 })
} catch (e) { emptyOk = false; emptyErr = e.message }
check('空数据渲染不抛异常', emptyOk, emptyErr)
check('空数据摘要不炸', avgSummary([]) === '暂无学科成绩')
check('fmtPct 对 0 与 null 都正确', fmtPct(0) === '0%' && fmtPct(null) === '—')

console.log('\n============================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('============================\n')
process.exit(fail === 0 ? 0 : 1)
