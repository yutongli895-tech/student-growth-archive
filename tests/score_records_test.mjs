// 成绩记录的整理与附件收集（K 套件，前端纯函数）
//
// 这组测试盯的是「改成绩」这条路上最容易悄悄错的两处：
//
//   1. 成绩分组里混进了辅助字段。
//      后端为了定位记录，会在每个考试对象里塞 _ids / _images。
//      如果摊平时只排除 '_images' 而漏了 '_ids'，列表里就会凭空多出一个
//      「_ids」科目，值还是个主键数字 —— 界面不报错，但教师会看到一个不存在的科目。
//      这类「多出一个字段」的 bug 不会崩、只会脏，必须靠断言字段集合来抓。
//
//   2. 附件收集的边界与话术。
//      张数上限、非图片文件、压缩后仍超大，三种情况的处理必须一致，
//      否则录入和修改两处会对同一张图给出不同结论。
//      compressImage 依赖 DOM，所以 collectImages 留了注入点，用假压缩器测规则本身。
//
// 运行：node tests/score_records_test.mjs（或 node run_all_tests.mjs）

import {
  groupScoreRecords, examNameOptions, isSuspectScore, scoreEditState,
  PLAUSIBLE_MIN, PLAUSIBLE_MAX
} from '../src/utils/scoreRecords.js'
import {
  collectImages, MAX_IMAGES, MAX_DATA_URL_LENGTH, compressImage
} from '../src/utils/imageCompress.js'

let pass = 0
let fail = 0
function c(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')) }
}

const DATA = [
  {
    exam: '月考1',
    语文: 90,
    数学: 85,
    _ids: { 语文: 11, 数学: 12 },
    _images: { 语文: ['data:image/jpeg;base64,AAA'], 数学: [] }
  },
  {
    exam: '期中',
    语文: 1000,        // 明显录错
    英语: 0,
    _ids: { 语文: 13, 英语: 14 },
    _images: {}
  }
]

// ============================================================
console.log('\n--- 1. 摊平成可编辑的记录 ---')
const flat = groupScoreRecords(DATA)

c('两次考试分成两组', flat.groups.length === 2, JSON.stringify(flat.groups.map(g => g.exam)))
c('考试顺序按录入顺序（与趋势图一致）',
  flat.groups.map(g => g.exam).join(',') === '月考1,期中',
  flat.groups.map(g => g.exam).join(','))
c('总条数正确', flat.rowCount === 4, String(flat.rowCount))

const g1 = flat.groups[0]
c('第一组两科', g1.rows.length === 2)
c('科目名正确（不含 exam）', g1.rows.map(r => r.subject).sort().join(',') === '数学,语文',
  g1.rows.map(r => r.subject).join(','))

// 关键回归：辅助字段不能变成科目
const allSubjects = flat.groups.flatMap(g => g.rows.map(r => r.subject))
c('_ids 没有被当成一个科目', !allSubjects.includes('_ids'), allSubjects.join(','))
c('_images 没有被当成一个科目', !allSubjects.includes('_images'), allSubjects.join(','))
// 语文在两个组里各出现一次（月考1 + 期中），所以这里比的是去重后的科目集合
const subjectSet = [...new Set(allSubjects)].sort().join(',')
c('科目集合恰好是 语文/数学/英语', subjectSet === '数学,英语,语文', subjectSet)

c('每行带着自己的成绩行主键（改/删靠它定位）',
  g1.rows.find(r => r.subject === '语文').scoreId === 11 &&
  g1.rows.find(r => r.subject === '数学').scoreId === 12,
  JSON.stringify(g1.rows.map(r => [r.subject, r.scoreId])))
c('没有行主键的行被计数为「无法定位」', flat.unaddressable === 0, String(flat.unaddressable))

c('附件张数按科目归属',
  g1.rows.find(r => r.subject === '语文').imageCount === 1 &&
  g1.rows.find(r => r.subject === '数学').imageCount === 0)
c('附件内容也带出来（修改弹窗要展示缩略图）',
  g1.rows.find(r => r.subject === '语文').images.length === 1)

c('组内均分四舍五入到一位小数', g1.avg === 87.5, String(g1.avg))
c('第二组均分（1000 与 0 → 500）', flat.groups[1].avg === 500, String(flat.groups[1].avg))

// ============================================================
console.log('\n--- 2. 找出疑似录错的分数 ---')
c('每组的异常条数正确',
  g1.suspectCount === 0 && flat.groups[1].suspectCount === 1,
  `${g1.suspectCount} / ${flat.groups[1].suspectCount}`)
c('异常总数正确', flat.suspectCount === 1, String(flat.suspectCount))
c('1000 分被标记为异常',
  flat.groups[1].rows.find(r => r.subject === '语文').suspect === true)
c('0 分不算异常（0 分是真实存在的成绩）',
  flat.groups[1].rows.find(r => r.subject === '英语').suspect === false)
c('90 分不算异常', g1.rows.find(r => r.subject === '语文').suspect === false)

const bounds = [
  [PLAUSIBLE_MIN - 1, true], [PLAUSIBLE_MIN, false],
  [PLAUSIBLE_MAX, false], [PLAUSIBLE_MAX + 1, true]
]
c('量程边界：' + bounds.map(([v, e]) => `${v}=${e ? '异常' : '正常'}`).join(' '),
  bounds.every(([v, e]) => isSuspectScore(v) === e))
c('NaN 视为异常', isSuspectScore(NaN) === true)
c('小数正常（87.5 不算异常）', isSuspectScore(87.5) === false)

// ============================================================
console.log('\n--- 3. 拿不到行主键时的降级 ---')
const legacy = groupScoreRecords([{ exam: '月考1', 语文: 90, 数学: 85 }])
c('缺 _ids 时全部计为无法定位', legacy.unaddressable === 2, String(legacy.unaddressable))
c('缺行主键的记录 scoreId 为 null（UI 据此禁用按钮，而不是发出会 404 的请求）',
  legacy.groups[0].rows.every(r => r.scoreId === null))
c('缺 _ids 时科目仍然正常列出（不影响只读展示）',
  legacy.groups[0].rows.map(r => r.subject).sort().join(',') === '数学,语文')

// ============================================================
console.log('\n--- 4. 脏输入不能把页面搞崩 ---')
c('空数组', groupScoreRecords([]).rowCount === 0)
c('非数组（接口异常时）', groupScoreRecords(null).rowCount === 0 && groupScoreRecords(undefined).groups.length === 0)
c('只有 exam、没有科目 → 不产生空组',
  groupScoreRecords([{ exam: '月考1', _ids: {} }]).groups.length === 0)
c('科目值不是数字 → 不当成一条成绩',
  groupScoreRecords([{ exam: '月考1', 语文: '90', _ids: { 语文: 1 } }]).rowCount === 0)

// ============================================================
console.log('\n--- 5. 考试名称候选 ---')
const names = examNameOptions([
  { exam: '月考1' }, { exam: '期中' }, { exam: ' 月考1 ' }, { exam: '' }, { exam: '期中' }
])
c('去重且保持录入顺序', names.join(',') === '月考1,期中', names.join(','))
c('两端空白被规整后去重', names.length === 2)
c('空考试名被剔除', !names.includes(''))
c('非数组输入', examNameOptions(null).length === 0)

// ============================================================
console.log('\n--- 6. 修改弹窗的初值构造（成绩行主键必须带上） ---')
{
  const g = flat.groups[0]
  const row = g.rows.find(r => r.subject === '语文')
  const st = scoreEditState(g, row)
  c('带上成绩行主键（改/删全靠它定位）', st.scoreId === 11, JSON.stringify(st))
  c('考试名取自所属分组', st.exam_name === '月考1', st.exam_name)
  c('科目与分数取自该行', st.subject === '语文' && st.score === 90, `${st.subject}/${st.score}`)
  c('附件一并带出', st.images.length === 1)

  // 这条断言是这次真正的回归点：之前把状态构造写在组件里，
  // 漏了 scoreId 也没人发现 —— 保存会打到 /score/undefined 拿到 404，
  // 界面上只表现为「点了保存没反应」，而纯函数测试全绿。
  c('scoreId 不会被漏掉（漏了就是 404「点了没反应」）',
    'scoreId' in st && st.scoreId !== null && st.scoreId !== undefined, JSON.stringify(Object.keys(st)))

  const before = row.images.length
  st.images.push('data:image/jpeg;base64,ZZZ')
  c('附件是拷贝，改动不会污染原始数据（取消编辑要还原）', row.images.length === before,
    `原=${before} 现在=${row.images.length}`)

  const bare = scoreEditState({ exam: '期末' }, { scoreId: 7, subject: '化学', score: 66 })
  c('没有附件的记录 → 空数组而不是 undefined', Array.isArray(bare.images) && bare.images.length === 0)
  c('分组缺失时不崩（考试名退化为空串）', scoreEditState(null, { scoreId: 1, subject: '数学', score: 90 }).exam_name === '')
  c('缺行主键时为 null（调用方据此拒绝打开弹窗）',
    scoreEditState({ exam: '期末' }, { subject: '数学', score: 90 }).scoreId === null)

  // 从摊平结果直接喂进去，模拟组件的真实调用路径
  const st2 = scoreEditState(flat.groups[1], flat.groups[1].rows.find(r => r.subject === '英语'))
  c('摊平结果可直接作为入参（组件就是这么调的）',
    st2.scoreId === 14 && st2.exam_name === '期中' && st2.subject === '英语',
    JSON.stringify(st2))
}

// ============================================================
console.log('\n--- 7. 附件收集（注入假压缩器，不碰 DOM） ---')
const fakeFile = (name, type = 'image/jpeg') => ({ name, type })
const okCompress = async () => 'data:image/jpeg;base64,' + 'x'.repeat(100)
const bigCompress = async () => 'data:image/jpeg;base64,' + 'x'.repeat(MAX_DATA_URL_LENGTH + 10)
const boomCompress = async () => { throw new Error('解码失败') }

let r = await collectImages([fakeFile('a.jpg'), fakeFile('b.jpg')], 3, okCompress)
c('正常图片全部收下', r.added.length === 2 && r.errors.length === 0, JSON.stringify(r))
c('附件里带可读的文件名与体积',
  r.added[0].name.startsWith('a.jpg (') && r.added[0].name.includes('KB'), r.added[0].name)

r = await collectImages([fakeFile('a.jpg'), fakeFile('b.jpg'), fakeFile('c.jpg'), fakeFile('d.jpg')], 3, okCompress)
c('超出剩余名额时只收够数的', r.added.length === 3, String(r.added.length))
c('并且明确告知超出的被忽略了',
  r.errors.some(e => e.includes(String(MAX_IMAGES))), JSON.stringify(r.errors))

r = await collectImages([fakeFile('a.txt', 'text/plain'), fakeFile('b.jpg')], 3, okCompress)
c('非图片文件被跳过而不是拒收整批', r.added.length === 1 && r.added[0].name.startsWith('b.jpg'))
c('跳过的文件点名说明原因',
  r.errors.length === 1 && r.errors[0].includes('a.txt') && r.errors[0].includes('不是图片'),
  JSON.stringify(r.errors))

r = await collectImages([fakeFile('huge.jpg')], 3, bigCompress)
c('压缩后仍超 1MB 的不收', r.added.length === 0)
c('并说明是「压缩后仍超过」而不是「不是图片」',
  r.errors[0].includes('huge.jpg') && r.errors[0].includes('1MB'), r.errors[0])

r = await collectImages([fakeFile('broken.jpg'), fakeFile('good.jpg')], 3, async f => {
  if (f.name === 'broken.jpg') throw new Error('解码失败')
  return okCompress()
})
c('个别图片处理失败不影响其余的', r.added.length === 1 && r.added[0].name.startsWith('good.jpg'),
  JSON.stringify(r.added))
c('失败原因带上文件名与底层错误',
  r.errors[0].includes('broken.jpg') && r.errors[0].includes('解码失败'), r.errors[0])

r = await collectImages([fakeFile('a.jpg')], 0, okCompress)
c('名额为 0 时一张都不收', r.added.length === 0)
c('名额为 0 时也给出上限提示', r.errors.some(e => e.includes(String(MAX_IMAGES))), JSON.stringify(r.errors))

r = await collectImages([], 3, okCompress)
c('空选择不报错', r.added.length === 0 && r.errors.length === 0)
r = await collectImages(null, 3, okCompress)
c('files 为 null 不崩', r.added.length === 0)
r = await collectImages([fakeFile('a.jpg')], 99, okCompress)
c('剩余名额超过上限时按上限收敛', r.added.length === 1)

c('compressImage 在无 DOM 环境下会 reject 而不是静默返回',
  await compressImage({ name: 'x.jpg' }).then(() => false).catch(() => true))

console.log('\n============================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('============================')
process.exit(fail === 0 ? 0 : 1)
