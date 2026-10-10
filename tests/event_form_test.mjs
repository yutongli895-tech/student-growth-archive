// 成长时间线的表单初值与删除参数（N 套件，前端纯函数）
//
// 这组测试盯的是「给时间线加配图」这件事里两处和界面长得没关系、错了却看不出来的地方：
//
//   1. 表单初值。
//      附件数组是 eventForm 的一部分。初值里漏掉 images，点「配图」按钮就会在
//      f.images.push(...) 上抛错 —— 界面只表现为「点了没反应」，没有任何报错。
//      成绩那边踩过同一个坑（openEditor 漏了 scoreId，保存打到 /score/undefined）。
//
//   2. 删除的定位方式。
//      旧接口按 (日期,类型,内容) 三元组删，同一天、同类型、同内容的两条记录会被
//      一次删掉两条。加了配图之后，「看起来一模一样的记录」只会更多。
//      现在必须优先按行主键删 —— 这段判断放在组件外面才有办法断言。
//
// 运行：node tests/event_form_test.mjs（或 node run_all_tests.mjs）

import { readFileSync } from 'node:fs'
import { EVENT_TYPES, emptyEventForm, eventDeleteParams, eventImagePayload } from '../src/utils/eventForm.js'

let pass = 0
let fail = 0
function c(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')) }
}

// ============================================================
// 1. 表单初值
// ============================================================
console.log('\n[1] 表单初值')

const f = emptyEventForm()
c('初值里必须有 images（否则「配图」按钮一点就抛错）', Array.isArray(f.images), JSON.stringify(f))
c('初值 images 是空数组', f.images.length === 0)
c('初值日期为空', f.event_date === '', JSON.stringify(f.event_date))
c('初值内容为空', f.content === '', JSON.stringify(f.content))
c('默认类型取自 EVENT_TYPES', EVENT_TYPES.includes(f.event_type), String(f.event_type))

const f2 = emptyEventForm()
c('每次调用返回新对象（不是共享引用）', f !== f2)
c('两次调用的 images 也不是同一个数组', f.images !== f2.images,
  '共享引用的话，改了表单会污染下一次的重置')

f2.images.push({ src: 'data:image/jpeg;base64,X', name: 'x.jpg' })
c('往一次调用的结果里 push 不会影响另一次', f.images.length === 0 && f2.images.length === 1)

// 模拟组件里 onEventImgChange 的写法，确认「初值 + push」这条路是通的
const form = emptyEventForm()
form.images.push(...[{ src: 'a' }, { src: 'b' }].map(x => x))
c('初值结构支持组件里的 images.push(...added)', form.images.length === 2, JSON.stringify(form.images))

// ============================================================
// 2. 事件类型
// ============================================================
console.log('\n[2] 事件类型清单')
c('类型清单与后端/说明书一致（6 种）', EVENT_TYPES.length === 6, EVENT_TYPES.join(','))
c('类型里没有空值', EVENT_TYPES.every(t => typeof t === 'string' && t.trim() === t && t))
c('类型没有重复', new Set(EVENT_TYPES).size === EVENT_TYPES.length)
c('含「奖励 / 惩罚 / 比赛 / 活动 / 提醒 / 其他」',
  ['奖励', '惩罚', '比赛', '活动', '提醒', '其他'].every(t => EVENT_TYPES.includes(t)))

// ============================================================
// 3. 删除参数：优先行主键
// ============================================================
console.log('\n[3] 删除定位（优先 id）')

let p = eventDeleteParams({ id: 12, date: '2026-09-01', type: '奖励', content: 'x' })
c('拿得到 id 时只带 id', JSON.stringify(p) === JSON.stringify({ id: '12' }), JSON.stringify(p))
c('不会顺带把三元组也发过去（避免后端选错分支）', p.event_date === undefined && p.content === undefined)

p = eventDeleteParams({ id: '34', date: '2026-09-01', type: '奖励', content: 'x' })
c('字符串 id 也能用', p.id === '34', JSON.stringify(p))

p = eventDeleteParams({ date: '2026-09-01', type: '奖励', content: '忘了带作业' })
c('没有 id 时回落到三元组', p.id === undefined && p.event_date === '2026-09-01' &&
  p.event_type === '奖励' && p.content === '忘了带作业', JSON.stringify(p))

p = eventDeleteParams({ id: 0, date: '2026-09-01', type: '奖励', content: 'x' })
c('id=0 视为没有主键（自增从 1 开始，0 不是合法主键）', p.id === undefined, JSON.stringify(p))
p = eventDeleteParams({ id: null, date: '2026-09-01', type: '奖励', content: 'x' })
c('id=null 视为没有主键', p.id === undefined, JSON.stringify(p))
p = eventDeleteParams({ id: 'abc', date: '2026-09-01', type: '奖励', content: 'x' })
c('id 不是数字时视为没有主键（不会被拼进 URL）', p.id === undefined, JSON.stringify(p))

p = eventDeleteParams(undefined)
c('事件对象缺失时返回空三元组而不是抛错',
  p.event_date === '' && p.event_type === '' && p.content === '', JSON.stringify(p))

// ============================================================
// 4. 提交给后端的附件
// ============================================================
console.log('\n[4] 附件提交形状')

const payload = eventImagePayload([
  { src: 'data:image/jpeg;base64,AAA', name: 'a.jpg (12KB)' },
  { src: 'data:image/jpeg;base64,BBB', name: 'b.jpg (20KB)' }
])
c('从 { src, name } 里只取 src',
  JSON.stringify(payload) === JSON.stringify(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
  JSON.stringify(payload))
c('不会把 name 一起提交（后端不认这个字段）',
  !JSON.stringify(payload).includes('KB'))

c('裸字符串数组原样通过',
  JSON.stringify(eventImagePayload(['data:image/jpeg;base64,X'])) === JSON.stringify(['data:image/jpeg;base64,X']))
c('过滤掉空值与非字符串',
  eventImagePayload([null, undefined, '', 123, { src: null }, 'ok']).length === 1,
  JSON.stringify(eventImagePayload([null, undefined, '', 123, { src: null }, 'ok'])))
c('空数组返回空数组', eventImagePayload([]).length === 0)
c('非数组输入不抛错', Array.isArray(eventImagePayload(undefined)) && eventImagePayload('x').length === 0)

// ============================================================
// 5. 结构断言：组件必须走这些纯函数，而不是各写一份
// ============================================================
console.log('\n[5] 组件结构（防止规则被写回组件里）')

const vue = readFileSync(new URL('../src/views/StudentProfile.vue', import.meta.url), 'utf8')
c('组件从 utils/eventForm.js 引入这四样',
  /import\s*\{[^}]*emptyEventForm[^}]*\}\s*from\s*'\.\.\/utils\/eventForm\.js'/.test(vue) &&
  vue.includes('eventDeleteParams') && vue.includes('eventImagePayload') && vue.includes('EVENT_TYPES'))
c('表单初值走 emptyEventForm()，不是内联字面量',
  vue.includes('ref(emptyEventForm())') && !vue.includes("event_type: '奖励'"))
c('删除走 eventDeleteParams，不再手写三元组',
  vue.includes('eventDeleteParams(e)') && !vue.includes('event_date: e.date, event_type: e.type'))
c('提交附件走 eventImagePayload，而不是直接发 images 对象数组',
  vue.includes('images: eventImagePayload(f.images)'))
c('事件类型下拉由 EVENT_TYPES 渲染',
  vue.includes('v-for="t in EVENT_TYPES"'))
c('配图入口受编辑模式管辖（挂在 canEdit 的表单里）',
  vue.includes('v-if="canEdit" class="event-form"') && vue.includes('@change="onEventImgChange"'))
c('待提交配图整块也受管辖',
  vue.includes('v-if="canEdit && eventForm.images.length"'))
c('时间线条目渲染附件并支持点击放大',
  vue.includes('class="event-img"') && vue.includes('v-if="e.images && e.images.length"'))

// 上限只在 imageCompress.js 定义一次，两处附件共用
c('配图上限复用 imageCompress 的 MAX_IMAGES（没有第二份数字）',
  vue.includes("from '../utils/imageCompress.js'") && vue.includes('MAX_IMAGES') &&
  !/图片最多\s*[:：]\s*\d/.test(vue))

// ============================================================
console.log('\n============================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('============================')
process.exit(fail === 0 ? 0 : 1)
