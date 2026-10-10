// 全局编辑模式 —— 回归测试
//
// 本轮需求：「开启编辑模式后，各种信息编辑进入编辑模式；不开启，各种信息编辑模式关闭。」
// 也就是一个开关管全站。本测试钉住四条不变量：
//
//   1. 【一个开关】关闭时全站写入入口全部收起 —— 用结构断言逐个入口钉住，
//      将来谁新增了写入按钮却忘了挂 canEdit，这个测试会立刻失败。
//   2. 【角色兜底】学生 / 家长永远只读，即使开关被打开。
//   3. 【不残留】编辑态存 sessionStorage 而非 localStorage —— 关掉标签页即回到只读，
//      不会出现「隔天回来数据还裸奔」。
//   4. 【响应式】切换账号 / 关掉开关后，canEdit 必须立即重算
//      （反面教材：computed 直接读 localStorage，首次求值后永久缓存）。
//
// 不依赖浏览器：手写最小 localStorage / sessionStorage / window 桩，用 Vue 真实响应式跑。
//
// 运行（在仓库根目录执行）：
//   cd student-growth-archive && node tests/edit_mode_test.mjs
//
// 路径全部基于本文件位置解析，所以在哪个目录下执行都一样。
// 唯一的约束：必须放在仓库内 —— 注释里那句「用 Vue 真实响应式」要求测试与被测代码共用
// 同一个 vue 实例。若把测试挪到仓库外、另起一份 vue，响应式会静默失效
// （computed 永不重算），测试就变成自欺欺人了。

import { computed } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------- 最小浏览器环境桩 ----------
function makeStore() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _dump: () => Object.fromEntries(map)
  }
}
globalThis.localStorage = makeStore()
globalThis.sessionStorage = makeStore()
globalThis.window = { addEventListener() {} }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')   // 仓库根
const read = p => readFileSync(join(ROOT, p), 'utf8')
const load = p => import(pathToFileURL(join(ROOT, p)).href)

const auth = await load('src/api/auth.js')
const em = await load('src/utils/editMode.js')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')) }
}

const teacher = { token: 'T', role: 'teacher', user: { id: 'T1', name: '王月', className: '一年级(1)班' } }
const student = { token: 'S', role: 'student', user: { id: 'S1', name: '李皓', className: '一年级(1)班' } }
const parent  = { token: 'P', role: 'parent',  user: { id: 'P1', name: '李皓家长' } }
const admin   = { token: 'A', role: 'admin',   user: { id: 'A1', name: '教务' } }

console.log('\n[1] 默认是只读')
auth.logout(); em.resetEditMode()
check('开关默认关闭', em.isEditMode() === false)
check('未登录时不可编辑', em.canEditNow() === false)

console.log('\n[2] 教师开启开关 → 全站可编辑')
auth.setSession(teacher, true)
check('开启前：教师也是只读', em.canEditNow() === false, '（这是本轮需求的关键：不开启就是关闭）')
em.setEditMode(true)
check('开关状态 = 开', em.isEditMode() === true)
check('教师可编辑', em.canEditNow() === true)

console.log('\n[3] 关闭 → 立即回到全站锁定')
em.setEditMode(false)
check('教师再次不可编辑', em.canEditNow() === false)
check('sessionStorage 里的编辑态已清除', sessionStorage.getItem('sga_edit_mode') === null,
  JSON.stringify(sessionStorage._dump()))
em.setEditMode(true)
check('开启后写入的是 sessionStorage', sessionStorage.getItem('sga_edit_mode') === '1',
  JSON.stringify(sessionStorage._dump()))
check('绝不写入 localStorage（不跨会话残留编辑权限）',
  localStorage.getItem('sga_edit_mode') === null, JSON.stringify(localStorage._dump()))

console.log('\n[4] 角色兜底：学生 / 家长即使开关被打开也永远只读')
em.setEditMode(true)
auth.setSession(student, true)
check('学生 → 不可编辑', em.canEditNow() === false)
check('学生关闭了开关状态吗？没有，开关本身仍是开（只是角色无权）', em.isEditMode() === true)
auth.setSession(parent, true)
check('家长 → 不可编辑', em.canEditNow() === false)
auth.setSession(admin, true)
check('管理员 → 可编辑', em.canEditNow() === true)
auth.setSession(teacher, true)
check('教师 → 可编辑', em.canEditNow() === true)

console.log('\n[5] 响应式：canEdit 必须随账号 / 开关立即重算')
const canEdit = computed(() => em.canEditNow())
check('教师时 canEdit = true', canEdit.value === true)
auth.setSession(student, true)                       // 换账号但不换开关
check('切换到学生后立即变 false（旧实现会永久缓存成 true）', canEdit.value === false,
  '实际=' + canEdit.value)
auth.setSession(teacher, true)
check('切回教师后立即变回 true', canEdit.value === true)
em.setEditMode(false)                                // 只动开关
check('关掉开关后立即变 false', canEdit.value === false)
em.setEditMode(true)
check('重新开启后立即变回 true', canEdit.value === true)

console.log('\n[6] 退出登录 / 切到只读角色时归零（防止编辑态跨账号泄漏）')
const appVue = read('src/App.vue')
check('handleLogout 里会 resetEditMode', /function handleLogout[\s\S]{0,200}resetEditMode\(\)/.test(appVue))
check('监听小写：切到非教职工角色时 resetEditMode',
  /watch\(isStaff[^)]*=>[\s\S]{0,80}resetEditMode\(\)/.test(appVue))
check('顶栏开关只对教职工显示', /v-if="isStaff"[\s\S]{0,200}class="edit-toggle"/.test(appVue))
check('开关有 role="switch" + aria-checked（键盘 / 读屏可达）',
  /role="switch"/.test(appVue) && /:aria-checked="String\(editMode\)"/.test(appVue))

// ============================================================
// [7] 结构断言：每一个写入入口都必须挂在 canEdit 之下
//     表里存的是「受管辖后的写法」。谁把它改回不受管辖的样子，
//     对应条目就会失配，测试立刻红。
// ============================================================
console.log('\n[7] 结构断言：全站写入入口逐个挂上 canEdit')

const GATES = [
  // —— 学生档案页：成绩录入、行为评分、作业提交情况、时间线增删 ——
  ['src/views/StudentProfile.vue', 'v-if="canEdit" class="btn outline sm" @click="openHomeworkEdit"', '作业提交情况入口'],
  ['src/views/StudentProfile.vue', 'v-if="canEdit" class="btn outline sm" @click="openBehaviorEdit"', '行为评分入口'],
  ['src/views/StudentProfile.vue', 'v-if="canEdit" class="card no-print"', '添加成绩卡片'],
  ['src/views/StudentProfile.vue', 'v-if="canEdit" class="event-form"', '时间线添加表单'],
  ['src/views/StudentProfile.vue', 'v-if="canEdit" class="del-btn" @click="doDeleteEvent(i)"', '时间线删除按钮'],
  ['src/views/StudentProfile.vue', 'v-if="canEdit && eventForm.images.length" class="img-preview-list"', '时间线待提交配图'],
  ['src/views/StudentProfile.vue', 'v-if="behaviorEditing && canEdit"', '行为评分弹窗'],
  ['src/views/StudentProfile.vue', 'v-if="homeworkEditing && canEdit"', '作业提交情况弹窗'],

  // —— 作业管理页：新建 / 标记 / 删除 / CSV 导入 ——
  ['src/views/HomeworkManage.vue', '<template v-if="canEdit">', '新建作业 + 批量录入按钮组'],
  ['src/views/HomeworkManage.vue', 'v-if="showImport && canEdit"', '批量录入面板'],
  ['src/views/HomeworkManage.vue', 'v-if="showCreate && canEdit"', '新建作业弹窗'],
  ['src/views/HomeworkManage.vue', 'v-if="markOpen && canEdit"', '标记提交情况弹窗'],

  // —— 管理页：学生 / 教师账号增删改、成绩导入 ——
  ['src/views/Admin.vue', '<template v-if="canEdit">', '学生添加/导入按钮组 + 教师行内操作 + 四个编辑弹窗'],
  ['src/views/Admin.vue', 'v-if="canEdit" class="card-actions no-print"', '学生编辑/删除按钮'],
  ['src/views/Admin.vue', 'v-if="canEdit" class="btn" @click="showAddTeacher = true"', '添加教师按钮'],
  ['src/views/Admin.vue', '<div v-else class="card">', '成绩导入表单'],

  // —— 邀请码管理组件 ——
  ['src/components/InviteManager.vue', '<div v-else class="gen-box">', '生成邀请码表单'],
  ['src/components/InviteManager.vue', 'v-if="!c.used && canEdit"', '撤销邀请码按钮'],

  // —— 家长管理组件 ——
  ['src/components/ParentManager.vue', '<div v-else class="gen-box">', '创建家长表单'],
  ['src/components/ParentManager.vue', '<template v-if="canEdit">', '家长编辑/删除/关联操作'],
  ['src/components/ParentManager.vue', 'v-if="showEditParent && canEdit"', '编辑家长弹窗']
]

for (const [file, needle, label] of GATES) {
  const src = read(file)
  check(`${file.split('/').pop()} → ${label}`, src.includes(needle),
    `缺少受管辖写法：${needle}`)
}

console.log('\n[8] 每个接入开关的页面都要有 useEditMode 与只读提示')
const CONNECTED = [
  ['src/App.vue', '顶栏开关'],
  ['src/views/StudentProfile.vue', '学生档案页'],
  ['src/views/HomeworkManage.vue', '作业管理页'],
  ['src/views/Admin.vue', '管理页'],
  ['src/components/InviteManager.vue', '邀请码管理'],
  ['src/components/ParentManager.vue', '家长管理']
]
for (const [file, label] of CONNECTED) {
  const src = read(file)
  check(`${label} 引用了 useEditMode`, /from '[^']*utils\/editMode\.js'/.test(src))
}

// 有写入入口的页面，只读时必须告诉用户「为什么看不到编辑按钮 + 怎么打开」。
// 上一版正是栽在这里：按钮藏了却没给出路，教师以为系统不给编辑。
const HINTS = [
  'src/views/StudentProfile.vue',
  'src/views/HomeworkManage.vue',
  'src/views/Admin.vue',
  'src/components/InviteManager.vue',
  'src/components/ParentManager.vue'
]
for (const file of HINTS) {
  const src = read(file)
  check(`${file.split('/').pop()} 有只读提示 + 开启出口`,
    src.includes('readonly-hint') && /readonly-hint[\s\S]{0,400}toggleEditMode/.test(src))
}

console.log('\n[9] 关闭编辑模式时不能留下可提交的弹窗（旁路防护）')
const WATCHED = [
  ['src/views/StudentProfile.vue', ['behaviorEditing', 'homeworkEditing'], '学生档案页弹窗'],
  ['src/views/HomeworkManage.vue', ['showCreate', 'showImport', 'markOpen'], '作业管理页弹窗'],
  ['src/views/Admin.vue', ['showAdd', 'showAddTeacher', 'showEditStudent', 'showEditTeacher'], '管理页弹窗']
]
for (const [file, vars, label] of WATCHED) {
  const src = read(file)
  const block = (src.match(/watch\(editMode[\s\S]*?\n\}\)/) || [''])[0]
  const allClosed = vars.every(v => block.includes(v + '.value = false'))
  check(`${label}：关闭开关时会把还开着的弹窗收起`, allClosed,
    block ? 'watch 块内容：' + block.replace(/\s+/g, ' ').slice(0, 160) : '找不到 watch(editMode) 块')
}

console.log('\n[10] 顶栏开关样式齐全（全局样式，非某个页面的局部样式）')
const css = read('src/styles/main.css')
check('.edit-toggle 定义在全局样式里', css.includes('.edit-toggle'))
check('开关有开 / 关两种视觉状态', css.includes('.edit-toggle.on') && css.includes('.et-track.on'))
check('.readonly-hint 定义在全局样式里（多页复用同一套说法）', css.includes('.readonly-hint'))
check('打印时不会带出编辑态控件（topbar 已被 no-print 规则隐藏）',
  /\.topbar, \.no-print, \.btn \{ display: none !important; \}/.test(css))

console.log('\n============================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('============================')
process.exit(fail ? 1 : 0)
