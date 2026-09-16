/**
 * ECharts 按需引入（tree-shaking）
 *
 * 全量 `import * as echarts from 'echarts'` 会把所有图表类型和组件打进产物，
 * 本项目只用到「折线图 + 雷达图 + 柱状图」，因此改为按需注册：
 *   core + 需要的图表 + 需要的组件 + Canvas 渲染器
 *
 * 所有图表组件统一从这里 import，保证只注册一次、避免重复打包。
 *
 * 新增图表类型时，在下面的 use() 里补上对应模块即可，
 * 不要退回全量引入（会让产物体积翻数倍）。
 */
import * as echarts from 'echarts/core'
import { LineChart, RadarChart, BarChart } from 'echarts/charts'
import {
  TooltipComponent,   // 成绩趋势 / 雷达图 / 学科分析的 tooltip
  LegendComponent,    // 成绩趋势图例
  GridComponent,      // 直角坐标系（折线图 / 柱状图）
  RadarComponent,     // 雷达坐标系
  MarkLineComponent,  // 学科平均分图的及格线 / 优秀线参考线
  GraphicComponent    // 雷达图空态提示文字（graphic.text）
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  RadarChart,
  BarChart,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  RadarComponent,
  MarkLineComponent,
  GraphicComponent,
  CanvasRenderer
])

export default echarts
