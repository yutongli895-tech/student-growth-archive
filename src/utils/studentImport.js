// 学生批量导入的「解析 + 逐行校验」。
//
// 为什么要单独成文件：
//   1. 纯函数（不碰 DOM、不碰网络），可以直接单测 —— 而导入恰恰是最需要
//      在提交前拦住错误的地方：它是唯一能一次性造出大量脏数据的入口。
//   2. 校验规则必须与后端 handleImportStudents 保持同一套口径，
//      两边分开写、分开测，才不会出现「预览说能导、提交后被逐行拒绝」。

// 「全部班级」在后端是筛选哨兵（等价于「不筛选」），不是真实班级名。
// 它曾经被真正写进学生记录（管理员账号的班级字段恰好是它，而导入当时
// 写死用导入者的班级），产生了一批既筛不出来、又污染所有班级视图的脏数据。
export const CLASS_FILTER_ALL = '全部班级'

/** 解析学生导入 CSV 文本 → 行对象数组（含原始行号） */
export function parseStudentCSV(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    // 表头识别：第一行含「学号」就跳过（用户可能从 Excel 直接复制，表头顺序不一定一致）
    if (i === 0 && lines[0].includes('学号')) continue
    const c = lines[i].split(',')
    // 这里刻意「原样带回」而不是丢弃缺字段的行：
    // 老实现是 `if (account && name && className) rows.push(...)`，
    // 于是某行漏填班级会被无声丢掉 —— 用户以为导入了 50 人、实际只进去 30 人，
    // 而且界面上没有任何提示。现在把这些行交给预览界面逐行说明原因。
    rows.push({
      row: i + 1,
      account: (c[0] || '').trim(),
      name: (c[1] || '').trim(),
      className: (c[2] || '').trim(),
      password: (c[3] || '').trim()
    })
  }
  return rows
}

/**
 * 逐行给出导入结论。
 * @param rows             parseStudentCSV 的结果
 * @param fallbackClass    CSV 未填班级时的兜底班级（= 导入者自己的班级；哨兵值请传空串）
 * @param existingAccounts 库里已存在的学号集合（用于提示「将跳过」）
 * @returns [{ row, account, name, className, password, level: 'ok'|'bad'|'skip', reason }]
 */
export function buildImportPreview(rows, { fallbackClass = '', existingAccounts = new Set() } = {}) {
  const out = []
  const seen = new Set()

  for (const r of rows) {
    const account = String(r.account || '').trim()
    const name = String(r.name || '').trim()
    const rawClass = String(r.className || '').trim()
    const className = rawClass || fallbackClass

    let level = 'ok'
    let reason = ''
    if (!account || !name) {
      level = 'bad'
      reason = '学号或姓名为空'
    } else if (!className) {
      level = 'bad'
      reason = '缺少班级：CSV 未填班级列，且你的账号也没有绑定班级'
    } else if (className === CLASS_FILTER_ALL) {
      level = 'bad'
      reason = `班级不能是「${CLASS_FILTER_ALL}」（那是筛选用的保留名）`
    } else if (seen.has(account)) {
      level = 'bad'
      reason = '同一个文件里学号重复'
    } else if (existingAccounts.has(account)) {
      level = 'skip'
      reason = '学号已存在，导入时会跳过'
    }

    // 无论判定结果如何都要记入 seen：
    // 否则「A、A、A」三行的后两行会被当成正常重复而非文件内重复，提示会失真。
    seen.add(account)
    out.push({ row: r.row, account, name, className, password: r.password || '', level, reason })
  }
  return out
}

/** 从导入者的会话信息里算出兜底班级（哨兵值与空值都视为「没有班级」） */
export function fallbackClassOf(user) {
  const cls = String((user && user.className) || '').trim()
  return cls && cls !== CLASS_FILTER_ALL ? cls : ''
}

/** 预览统计，供界面显示 */
export function summarizeImport(preview) {
  return {
    total: preview.length,
    valid: preview.filter(r => r.level === 'ok').length,
    skipped: preview.filter(r => r.level === 'skip').length,
    problems: preview.filter(r => r.level === 'bad').length
  }
}
