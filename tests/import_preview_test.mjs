// 学生批量导入的「解析 + 逐行校验」回归测试
//
// 为什么单独测它：
//   批量导入是唯一能一次性造出大量脏数据的入口。线上就出过一次事 ——
//   用一个格式不对的 CSV 导入，产生了 48 条班级写成「全部班级」的学生记录，
//   而这批数据既筛不出来、又会污染所有按班级过滤的视图，事后只能人肉清理。
//
//   这段逻辑是纯函数，所以可以被完整钉住：解析、缺字段、哨兵班级、
//   文件内重复、已存在跳过，以及最关键的「CSV 的班级列必须被尊重」。
//
// 运行：node tests/import_preview_test.mjs

import { parseStudentCSV, buildImportPreview, fallbackClassOf, summarizeImport, CLASS_FILTER_ALL }
  from '../src/utils/studentImport.js'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')) }
}

console.log('\n##### 批量导入：解析与逐行校验 #####\n')
console.log('--- 1. CSV 解析 ---')

const csv = [
  '学号,姓名,班级,初始密码',
  '2024001,张三,一年级(1)班,',
  '2024002,李四,一年级(1)班,abc123',
  '',
  '2024003,王五,一年级(2)班,'
].join('\n')

const parsed = parseStudentCSV(csv)
check('表头被跳过，得到 3 行数据', parsed.length === 3, JSON.stringify(parsed))
check('学号/姓名/班级解析正确',
  parsed[0].account === '2024001' && parsed[0].name === '张三' && parsed[0].className === '一年级(1)班')
check('密码列被带出', parsed[1].password === 'abc123')
check('行号按原文（表头占第 1 行，第 3 行是空行）',
  parsed[2].row === 4, JSON.stringify(parsed.map(r => r.row)))
check('全空内容不炸', parseStudentCSV('').length === 0)

const noHeader = parseStudentCSV('2024009,无表头,一年级(1)班,')
check('没有表头时首行也当数据（含「学号」关键词才跳过）', noHeader.length === 1, JSON.stringify(noHeader))

console.log('\n--- 2. 缺字段的行必须被带回，而不是静默丢弃 ---')
// 老实现是 `if (account && name && className) rows.push(...)`：
// 漏填班级的行会被无声丢掉，用户以为导入了 3 人、实际只进去 1 人。
const holes = parseStudentCSV([
  '学号,姓名,班级',
  '2024001,张三,一年级(1)班',
  ',李四,一年级(1)班',
  '2024003,,一年级(1)班',
  '2024004,王五,'
].join('\n'))
check('4 行全部保留（不再静默丢弃）', holes.length === 4, JSON.stringify(holes))

console.log('\n--- 3. 逐行结论 ---')

const preview = buildImportPreview(holes, { fallbackClass: '', existingAccounts: new Set() })
check('正常行 → ok', preview[0].level === 'ok', JSON.stringify(preview[0]))
check('缺学号 → bad', preview[1].level === 'bad' && preview[1].reason.includes('学号'), JSON.stringify(preview[1]))
check('缺姓名 → bad', preview[2].level === 'bad', JSON.stringify(preview[2]))
check('缺班级且无兜底班级 → bad 并说明原因',
  preview[3].level === 'bad' && preview[3].reason.includes('缺少班级'), JSON.stringify(preview[3]))
check('统计：1 可导入 / 3 有问题',
  summarizeImport(preview).valid === 1 && summarizeImport(preview).problems === 3,
  JSON.stringify(summarizeImport(preview)))

console.log('\n--- 4. 「全部班级」是保留名，绝不能当班级用 ---')
const sentinel = buildImportPreview(
  [{ row: 2, account: 'X1', name: '某人', className: CLASS_FILTER_ALL }],
  { fallbackClass: '', existingAccounts: new Set() }
)
check('班级为「全部班级」→ bad', sentinel[0].level === 'bad', JSON.stringify(sentinel[0]))
check('原因里点明这是保留名', sentinel[0].reason.includes('保留名'), sentinel[0].reason)

console.log('\n--- 5. 兜底班级（CSV 未填班级列时）---')
const withFallback = buildImportPreview(
  [{ row: 2, account: 'Y1', name: '甲', className: '' }],
  { fallbackClass: '一年级(1)班', existingAccounts: new Set() }
)
check('CSV 没填班级 → 用导入者班级兜底，且判定为可导入',
  withFallback[0].level === 'ok' && withFallback[0].className === '一年级(1)班',
  JSON.stringify(withFallback[0]))
check('CSV 填了班级 → 以 CSV 为准（不被导入者班级覆盖）',
  buildImportPreview(
    [{ row: 2, account: 'Y2', name: '乙', className: '二年级(3)班' }],
    { fallbackClass: '一年级(1)班', existingAccounts: new Set() }
  )[0].className === '二年级(3)班')

check('管理员（班级=哨兵）没有兜底班级，CSV 又不填 → 拒绝并解释',
  buildImportPreview([{ row: 2, account: 'Y3', name: '丙', className: '' }],
    { fallbackClass: fallbackClassOf({ className: CLASS_FILTER_ALL }), existingAccounts: new Set() }
  )[0].level === 'bad')
check('fallbackClassOf 把哨兵班级视同没有班级', fallbackClassOf({ className: CLASS_FILTER_ALL }) === '')
check('fallbackClassOf 正常返回真实班级', fallbackClassOf({ className: ' 三年级(1)班 ' }) === '三年级(1)班')
check('fallbackClassOf 对空用户不炸', fallbackClassOf(null) === '')

console.log('\n--- 6. 文件内重复 / 库里已存在 ---')
const dup = buildImportPreview([
  { row: 2, account: 'D1', name: '首个', className: '一年级(1)班' },
  { row: 3, account: 'D1', name: '重复', className: '一年级(1)班' },
  { row: 4, account: 'D2', name: '已存在', className: '一年级(1)班' }
], { fallbackClass: '', existingAccounts: new Set(['D2']) })

check('首行正常', dup[0].level === 'ok', JSON.stringify(dup[0]))
check('第二行被判为「文件内重复」',
  dup[1].level === 'bad' && dup[1].reason.includes('重复'), JSON.stringify(dup[1]))
check('库里已存在的判为 skip（不是失败）',
  dup[2].level === 'skip' && dup[2].reason.includes('跳过'), JSON.stringify(dup[2]))
check('统计把 skip 单独计数',
  summarizeImport(dup).valid === 1 && summarizeImport(dup).skipped === 1 && summarizeImport(dup).problems === 1,
  JSON.stringify(summarizeImport(dup)))

console.log('\n--- 7. 大小写 / 空白 / 边界 ---')
const messy = buildImportPreview([
  { row: 2, account: '  2024010  ', name: '  空格  ', className: '  一年级(1)班  ' }
], { fallbackClass: '', existingAccounts: new Set() })
check('前后空白被裁掉',
  messy[0].account === '2024010' && messy[0].name === '空格' && messy[0].className === '一年级(1)班',
  JSON.stringify(messy[0]))
check('空数组不炸', buildImportPreview([], {}).length === 0)
check('缺 password 字段不炸', buildImportPreview([{ row: 1, account: 'a', name: 'b', className: 'c' }], {})[0].password === '')

console.log('\n============================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('============================\n')
process.exit(fail ? 1 : 0)
