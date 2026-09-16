/**
 * 学生成绩记录的整理与体检（纯函数，可单测）
 *
 * 后端把成绩按「考试」分组交给前端：
 *   [{ exam:'月考1', 语文:90, 数学:85, _ids:{语文:12,数学:13}, _images:{语文:[...]} }]
 *
 * 页面要的是「一行一条成绩记录」的可编辑列表，所以这里做三件事：
 *   1. 摊平成记录行，并把成绩行主键（_ids）挂到每一行上 —— 改/删都靠它定位；
 *   2. 算出每次考试的科目数与均分（分组标题要用），保持与图表同一顺序（按录入先后）；
 *   3. 标出「疑似录错」的分数，让教师一眼看到要改哪一条。
 *
 * 关于第 3 点：这个功能的起因就是「录错了没法改」。光给一个修改按钮不够——
 * 一学期几百条记录，教师未必记得是哪一条错了。所以顺手把明显越界的分数标出来，
 * 把「找错」这件事也从人脑里拿掉。
 */

/** 常规百分制量程。超出这个范围不拒绝（150 分制、体育 1000 分制都存在），只提示。 */
export const PLAUSIBLE_MIN = 0
export const PLAUSIBLE_MAX = 100

/** 疑似录错的分数：负数、四位数、NaN 之类明显越界的值 */
export function isSuspectScore(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return true
  return n < PLAUSIBLE_MIN || n > PLAUSIBLE_MAX
}

/**
 * 摊平成可编辑的成绩记录。
 *
 * @returns {{
 *   groups: { exam, rows, count, avg, suspectCount }[],
 *   rowCount: number,        // 总记录条数
 *   suspectCount: number,    // 疑似录错的条数
 *   unaddressable: number    // 拿不到行主键、因而无法改删的条数（老数据/接口未升级）
 * }}
 */
export function groupScoreRecords(scores) {
  const groups = []
  let rowCount = 0
  let suspectCount = 0
  let unaddressable = 0

  for (const exam of Array.isArray(scores) ? scores : []) {
    const examName = String(exam?.exam ?? '')
    const ids = exam?._ids || {}
    const images = exam?._images || {}
    const rows = []

    for (const [key, value] of Object.entries(exam || {})) {
      // 跳过 exam 本身，以及 _ids / _images 这类下划线开头的辅助字段。
      // 不做这个过滤，_ids 的数值会被当成一个叫「_ids」的科目画进列表。
      if (key === 'exam' || key.startsWith('_')) continue
      if (typeof value !== 'number') continue

      const rawId = ids[key]
      const hasId = rawId !== undefined && rawId !== null && rawId !== ''
      if (!hasId) unaddressable++
      const suspect = isSuspectScore(value)
      if (suspect) suspectCount++

      rows.push({
        scoreId: hasId ? Number(rawId) : null,
        subject: key,
        score: value,
        images: Array.isArray(images[key]) ? images[key] : [],
        imageCount: Array.isArray(images[key]) ? images[key].length : 0,
        suspect
      })
    }

    if (!rows.length) continue
    rowCount += rows.length
    const sum = rows.reduce((a, r) => a + (Number(r.score) || 0), 0)
    groups.push({
      exam: examName,
      rows,
      count: rows.length,
      avg: Math.round((sum / rows.length) * 10) / 10,
      suspectCount: rows.filter(r => r.suspect).length
    })
  }

  return { groups, rowCount, suspectCount, unaddressable }
}

/** 已有成绩里出现过的考试名称（去重、保持录入顺序）—— 修改时作为候选，避免「期中」写成「期中 」两场考试 */
export function examNameOptions(scores) {
  const names = []
  const seen = new Set()
  for (const exam of Array.isArray(scores) ? scores : []) {
    const n = String(exam?.exam ?? '').trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    names.push(n)
  }
  return names
}

/**
 * 由一条成绩记录生成「修改」弹窗的初始状态。
 *
 * 为什么要单独抽出来：这里的 scoreId 是改、删唯一的定位依据，而它和界面长得
 * 一点关系都没有 —— 表单里显示的是考试名/科目/分数。一旦构造时漏掉 scoreId，
 * 保存请求会打到 /student/X/score/undefined 上拿到 404，界面表现仅仅是
 * 「点了保存没反应」；纯函数测试也照样全绿（它们测的是摊平，不是表单构造）。
 * 所以这段状态构造必须能被断言，而不是埋在组件里。
 *
 * images 做了一次浅拷贝：弹窗里删附件不该直接把 props 上的数组改掉，
 * 取消编辑时原件必须还是原样。
 */
export function scoreEditState(group, row) {
  return {
    scoreId: row?.scoreId ?? null,
    exam_name: String(group?.exam ?? ''),
    subject: row?.subject ?? '',
    score: row?.score ?? '',
    images: Array.isArray(row?.images) ? [...row.images] : []
  }
}
