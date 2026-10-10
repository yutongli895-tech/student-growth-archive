/**
 * Student Growth Archive — CF Pages Functions API
 * 全部路由逻辑从 Worker src/index.js 移植，入口适配 Pages Functions 签名。
 * 路由前缀: /api/* （由 Pages 静态文件规则 /functions/api/* 映射）
 */

// ===== 工具函数 =====
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
}

function normalizeClassName(name) {
  if (!name) return name
  return String(name)
    .replace(/\uFF08/g, '(').replace(/\uFF09/g, ')')
    .replace(/\uFE5F/g, '(').replace(/\uFF5F/g, ')')
    .trim()
}

// ===== 班级名合法性 =====
// 「全部班级」是界面上的筛选哨兵（语义等于「不筛选」），不是真实班级名。
// 它曾经被真正写进学生记录：管理员账号 A001 的 class_name 恰好是它，
// 而批量导入当时写死 className = teacher.className，于是 48 名学生全被
// 打成「全部班级」。后果是这批学生既筛不出来、又会污染所有按班级过滤的视图
// （dbGetStudents 里「全部班级」等于不带条件，一选就返回全校）。
// 因此：任何写入口都必须拒绝哨兵值与空值。
const CLASS_FILTER_ALL = '全部班级'
function isRealClassName(v) {
  const s = normalizeClassName(v || '')
  return !!s && s !== CLASS_FILTER_ALL
}

// D1 单条 SQL 的绑定参数上限是 100（超过报 too many SQL variables）。
// 所有 IN (...) 批量查询/删除都必须分片，否则「数据一多就整体报错」，
// 这和 N+1 是同一类病：小数据量下一切正常，数据一涨就崩。
const D1_MAX_PARAMS = 90
function chunksOf(arr, size = D1_MAX_PARAMS) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// 班级名是否像是「编码损坏的垃圾」（现网 classrooms 表里混进了 GBK↔UTF-8 误码：
// 例如 U+FFFD 替换字符、CJK 私用区的半截字节）。这类名字没有任何学校会用，
// 展示出来只会让下拉框变成乱码墙。
function isCorruptClassName(v) {
  const s = String(v ?? '')
  if (!s) return true
  // U+FFFD（替换字符）说明解码时就已经丢了信息，无法还原
  if (s.includes('\uFFFD')) return true
  // 全是非 ASCII 可打印的杂符（控制字符/私用区）
  if (/[\uE000-\uF8FF]/.test(s)) return true
  if (/[\u0000-\u001F\u007F]/.test(s)) return true
  return false
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

function extractToken(request) {
  const auth = request.headers.get('Authorization') || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

async function authenticate(request, env) {
  const token = extractToken(request)
  if (!token) return null
  const sessionData = await env.SESSIONS.get(`session:${token}`)
  if (!sessionData) return null
  try { return JSON.parse(sessionData) } catch { return null }
}

async function requireAuth(request, env) {
  const user = await authenticate(request, env)
  if (!user) return { user: null, response: jsonResp({ error: '未登录或登录已过期' }, 401) }
  return { user, response: null }
}

async function requireTeacher(request, env) {
  const { user, response } = await requireAuth(request, env)
  if (response) return { user: null, response }
  if (user.role !== 'teacher' && user.role !== 'admin') {
    return { user: null, response: jsonResp({ error: '需要教师或管理员权限' }, 403) }
  }
  return { user, response: null }
}

async function requireAdmin(request, env) {
  const { user, response } = await requireAuth(request, env)
  if (response) return { user: null, response }
  if (user.role !== 'admin') {
    return { user: null, response: jsonResp({ error: '需要管理员权限' }, 403) }
  }
  return { user, response: null }
}

async function requireParent(request, env) {
  const { user, response } = await requireAuth(request, env)
  if (response) return { user: null, response }
  if (user.role !== 'parent') {
    return { user: null, response: jsonResp({ error: '需要家长权限' }, 403) }
  }
  return { user, response: null }
}

// ===== 科目库（覆盖小学到高中常见科目）=====
const SUBJECTS = [
  '语文', '数学', '英语', '音乐', '美术', '体育', '道法', '科学',
  '物理', '化学', '生物', '历史', '地理', '政治', '信息技术', '通用技术'
]

// 科目列表（公开元数据）
async function handleListSubjects() {
  return jsonResp(SUBJECTS)
}

// ===== D1 查询函数 =====

async function dbGetStudents(env, className, onlyId) {
  let query = `SELECT u.id, u.name, u.class_name, u.role FROM users u WHERE u.role = 'student'`
  let params = []
  // onlyId：学生端只能取自己这一条（班级名单属于教师/管理员的管理数据）
  if (onlyId) {
    query += ` AND u.id = ?`
    params.push(onlyId)
  } else if (className && className !== CLASS_FILTER_ALL) {
    query += ` AND u.class_name = ?`
    params.push(className)
  }
  query += ` ORDER BY u.id`
  const { results } = await env.DB.prepare(query).bind(...params).all()
  const rows = results || []
  if (!rows.length) return []

  const ids = rows.map(r => r.id)

  // ⚠️ 这里以前是项目里最严重的性能陷阱（也是「请求失败: 503」的根因）：
  // 每个学生各查一次成绩、一次作业汇总 → 单次请求 1 + 2N 条串行 SQL。
  // 81 名学生 = 163 条 SQL，单请求要 2.3 秒；并发 25 个请求时单请求涨到 14 秒，
  // 直接撞上 Cloudflare 免费版的 CPU 上限，边缘返回
  //   「Worker exceeded resource limits」503
  // —— 页面上就表现为「学生列表整个空了，什么都点不了」。
  // 现在改成「按 id 分片的一次性查询」：SQL 条数与学生数无关（恒定 1 + 2×分片数）。
  // 对照写法见 handleListHomeworkAssignments（它早就是批量查询）。

  // ① 作业提交率：原本每人一条 SELECT ... WHERE student_id = ?
  const rateById = new Map()
  try {
    for (const chunk of chunksOf(ids)) {
      const { results: hw } = await env.DB.prepare(
        `SELECT student_id, rate FROM homework WHERE student_id IN (${placeholders(chunk.length)})`
      ).bind(...chunk).all()
      for (const r of hw || []) rateById.set(r.student_id, r.rate)
    }
  } catch {
    // 汇总表尚未建立（全新部署、尚未录入过作业数据）时静默降级为 0，
    // 不能让「一个功能没数据」升级成「班级概览整页报错」。
  }

  // ② 最近一次考试：原本每人一条 SELECT ... ORDER BY id DESC LIMIT 3
  //    用窗口函数一次取回「每个人的最新 3 行」；rn 升序 == 原 ORDER BY id DESC 的顺序，
  //    这样 examMap 的建键次序与「取最后一个考试」的语义跟改前完全一致（刻意不改行为）。
  const scoreRowsById = new Map()
  for (const chunk of chunksOf(ids)) {
    const { results: sc } = await env.DB.prepare(
      `SELECT student_id, exam_name, subject, score FROM (
         SELECT student_id, exam_name, subject, score,
                ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY id DESC) AS rn
         FROM scores
         WHERE student_id IN (${placeholders(chunk.length)})
       )
       WHERE rn <= 3
       ORDER BY student_id, rn`
    ).bind(...chunk).all()
    for (const r of sc || []) {
      if (!scoreRowsById.has(r.student_id)) scoreRowsById.set(r.student_id, [])
      scoreRowsById.get(r.student_id).push(r)
    }
  }

  return rows.map(s => {
    const examMap = {}
    for (const r of scoreRowsById.get(s.id) || []) {
      if (!examMap[r.exam_name]) examMap[r.exam_name] = { exam: r.exam_name }
      examMap[r.exam_name][r.subject] = r.score
    }
    return {
      id: s.id,
      name: s.name,
      className: s.class_name,
      lastExam: Object.values(examMap).pop() || {},
      homeworkRate: rateById.has(s.id) ? rateById.get(s.id) : 0
    }
  })
}

async function dbGetStudent(env, id) {
  const user = await env.DB.prepare(
    `SELECT id, name, class_name, role FROM users WHERE id = ? AND role = 'student'`
  ).bind(id).first()
  if (!user) return null

  const { results: scoreRows } = await env.DB.prepare(
    `SELECT id, exam_name, subject, score, images FROM scores WHERE student_id = ? ORDER BY id`
  ).bind(id).all()

  const examMap = {}
  for (const r of scoreRows) {
    if (!examMap[r.exam_name]) examMap[r.exam_name] = { exam: r.exam_name, _images: {}, _ids: {} }
    examMap[r.exam_name][r.subject] = r.score
    // 每科成绩的行主键一并带出：前端「修改/删除某一条成绩」要靠它定位。
    // 不暴露主键的话，前端只能拿 (考试,科目,分数) 去猜，改完分数就再也找不到自己了。
    // 下划线开头是为了跟「科目→分数」那层数据分开（学科分析、趋势图都按 _ 前缀跳过）。
    examMap[r.exam_name]._ids[r.subject] = r.id
    try { examMap[r.exam_name]._images[r.subject] = JSON.parse(r.images || '[]') } catch { examMap[r.exam_name]._images[r.subject] = [] }
  }
  const scores = Object.values(examMap)

  let homework = null
  try {
    homework = await env.DB.prepare(
      `SELECT total, missed, rate FROM homework WHERE student_id = ?`
    ).bind(id).first()
  } catch { homework = null }
  homework = homework || { rate: 0, missed: 0, total: 0 }

  // 作业明细（明细模型启用后才有数据；表尚未创建时静默降级为空数组）
  let homeworkDetail = []
  try {
    const { results: hwRows } = await env.DB.prepare(
      `SELECT ha.id AS id, ha.title AS title, ha.subject AS subject, ha.due_date AS dueDate,
              hr.status AS status, hr.note AS note
       FROM homework_records hr
       JOIN homework_assignments ha ON ha.id = hr.assignment_id
       WHERE hr.student_id = ?
       ORDER BY ha.due_date DESC, ha.id DESC
       LIMIT 15`
    ).bind(id).all()
    homeworkDetail = (hwRows || []).map(r => ({
      id: r.id,
      title: r.title,
      subject: r.subject,
      dueDate: r.dueDate,
      status: r.status,
      note: r.note || ''
    }))
  } catch { homeworkDetail = [] }

  const behaviorRow = await env.DB.prepare(
    `SELECT raise_hand, focus, cooperation, homework_quality FROM behavior WHERE student_id = ?`
  ).bind(id).first()

  const behavior = behaviorRow ? {
    举手: behaviorRow.raise_hand,
    专注: behaviorRow.focus,
    合作: behaviorRow.cooperation,
    作业质量: behaviorRow.homework_quality
  } : {}

  // 成长事件（含图片附件）。
  // id 必须带出去：前端删除要靠它定位。只按 (日期,类型,内容) 删的话，
  // 同一天同类型同内容的两条「双胞胎事件」会被一次删掉两条。
  await ensureEventImages(env)
  const events = await readEvents(env, id)

  const aiReportRow = await env.DB.prepare(
    `SELECT report_json FROM ai_reports WHERE student_id = ? ORDER BY generated_at DESC LIMIT 1`
  ).bind(id).first()
  let aiReport = null
  if (aiReportRow) {
    try { aiReport = JSON.parse(aiReportRow.report_json) } catch {}
  }

  return {
    id: user.id,
    name: user.name,
    className: user.class_name,
    scores,
    homework,
    homeworkDetail,
    behavior,
    events,
    aiReport
  }
}

// ===== Handler 函数 =====

// ===== 账号 CRUD（编辑/删除）=====

// 编辑学生（教师/管理员）
async function handleUpdateStudent(request, env, actor, id) {
  const { name, className, resetPassword } = await request.json()
  if (!name || !className) return jsonResp({ error: '姓名、班级为必填' }, 400)
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role = 'student'`).bind(id).first()
  if (!exists) return jsonResp({ error: '学生不存在' }, 404)

  const normalizedClass = normalizeClassName(className)
  if (!isRealClassName(normalizedClass)) {
    return jsonResp({ error: `班级名不能是「${CLASS_FILTER_ALL}」（那是筛选用的保留名），请填写真实班级` }, 400)
  }
  await env.DB.prepare(`UPDATE users SET name = ?, class_name = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, normalizedClass, id).run()

  if (resetPassword) {
    const newPwd = String(resetPassword).trim()
    if (newPwd.length < 6) return jsonResp({ error: '新密码至少 6 位' }, 400)
    const hash = await sha256(newPwd)
    await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_pwd = 1 WHERE id = ?`).bind(hash, id).run()
  }
  return jsonResp({ success: true })
}

// 删除学生（教师/管理员，级联删除关联数据）

// 学生名下的关联数据分布在 7 张表里。原实现只清了 6 张 —— 漏了 homework_records
// （作业明细），被删学生的明细记录会变成孤儿行：它会继续被统计口径扫到，
// 让「应交次数」凭空多出几个人头。
const STUDENT_CHILD_TABLES = [
  'scores', 'behavior', 'homework', 'events', 'ai_reports', 'parent_links', 'homework_records'
]

// 级联清除一批学生（供单删与批量删共用）。
// 走 D1 的 batch：一组 DELETE 在同一个事务里执行，只占一次往返。
// 逐条 await 的话「删 48 个学生」= 7×48 = 336 次串行往返，同样会撞上
// Cloudflare 的资源上限（和列表 N+1 是同一个病）。
async function purgeStudents(env, ids) {
  if (!ids.length) return

  // batch 是「一条失败整批回滚」，所以先探明哪些子表真实存在
  // （全新部署可能还没有 homework_records）。探明结果对整批 id 复用。
  let present = STUDENT_CHILD_TABLES
  try {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders(STUDENT_CHILD_TABLES.length)})`
    ).bind(...STUDENT_CHILD_TABLES).all()
    present = (results || []).map(r => r.name)
  } catch { /* 探测失败就按全表尝试 */ }

  for (const chunk of chunksOf(ids, 50)) {
    const ph = placeholders(chunk.length)
    const stmts = present.map(t =>
      env.DB.prepare(`DELETE FROM ${t} WHERE student_id IN (${ph})`).bind(...chunk)
    )
    stmts.push(env.DB.prepare(`DELETE FROM users WHERE id IN (${ph}) AND role = 'student'`).bind(...chunk))
    await env.DB.batch(stmts)
  }
}

async function handleDeleteStudent(request, env, actor, id) {
  const exists = await env.DB.prepare(`SELECT id, name, class_name FROM users WHERE id = ? AND role = 'student'`).bind(id).first()
  if (!exists) return jsonResp({ error: '学生不存在' }, 404)
  if (teacherOutOfScope(actor, exists.class_name)) {
    return jsonResp({ error: '该学生不在你负责的班级' }, 403)
  }
  await purgeStudents(env, [exists.id])
  return jsonResp({ success: true })
}

// 批量删除学生。
// 为什么必须有：逐条删除时每删一个都要重新拉一次学生列表，而列表一旦变慢
// （见 dbGetStudents 的 N+1 注释），删到一半就会整页 503 卡死，形成
// 「越删越动不了」的死循环 —— 这正是批量导入出错后无法收拾的原因。
async function handleBulkDeleteStudents(request, env, actor) {
  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }

  const raw = Array.isArray(body.ids) ? body.ids : []
  const ids = [...new Set(raw.map(v => String(v ?? '').trim()).filter(Boolean))]
  if (!ids.length) return jsonResp({ error: '请先勾选要删除的学生' }, 400)
  if (ids.length > 500) return jsonResp({ error: '单次最多删除 500 名学生' }, 400)

  const removed = []
  const skipped = []
  const removedIds = new Set()

  for (const chunk of chunksOf(ids, 50)) {
    const { results } = await env.DB.prepare(
      `SELECT id, name, class_name FROM users WHERE role = 'student' AND id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all()

    const allowed = []
    for (const r of (results || [])) {
      if (teacherOutOfScope(actor, r.class_name)) {
        skipped.push({ id: r.id, name: r.name, reason: '不在你负责的班级' })
      } else {
        allowed.push(r)
      }
    }
    if (!allowed.length) continue

    await purgeStudents(env, allowed.map(r => r.id))
    for (const r of allowed) { removed.push({ id: r.id, name: r.name }); removedIds.add(r.id) }
  }

  // 如实回报没删掉的：可能已被别处删除，或不在权限范围内
  for (const id of ids) {
    if (!removedIds.has(id) && !skipped.some(s => s.id === id)) {
      skipped.push({ id, reason: '学生不存在' })
    }
  }

  return jsonResp({
    success: true,
    removed: removed.length,
    removedStudents: removed,
    skipped
  })
}

// 编辑教师（管理员）
async function handleUpdateTeacher(request, env, admin, id) {
  const { name, className, role, resetPassword } = await request.json()
  if (!name || !className) return jsonResp({ error: '姓名、班级为必填' }, 400)
  const r = (role === 'admin') ? 'admin' : 'teacher'
  if (id === admin.id && r !== 'admin') {
    return jsonResp({ error: '不能将自身降级为教师' }, 400)
  }
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role IN ('teacher','admin')`).bind(id).first()
  if (!exists) return jsonResp({ error: '教师不存在' }, 404)
  const normalizedClass = normalizeClassName(className)
  await env.DB.prepare(`UPDATE users SET name = ?, class_name = ?, role = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, normalizedClass, r, id).run()
  if (resetPassword) {
    const newPwd = String(resetPassword).trim()
    if (newPwd.length < 6) return jsonResp({ error: '新密码至少 6 位' }, 400)
    const hash = await sha256(newPwd)
    await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_pwd = 1 WHERE id = ?`).bind(hash, id).run()
  }
  return jsonResp({ success: true })
}

// 删除教师（管理员）
async function handleDeleteTeacher(request, env, admin, id) {
  if (id === admin.id) return jsonResp({ error: '不能删除当前登录账号' }, 400)
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role IN ('teacher','admin')`).bind(id).first()
  if (!exists) return jsonResp({ error: '教师不存在' }, 404)
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run()
  return jsonResp({ success: true })
}

// 编辑家长（教师/管理员）
async function handleUpdateParent(request, env, actor, id) {
  const { name, resetPassword, studentIds } = await request.json()
  if (!name) return jsonResp({ error: '姓名为必填' }, 400)
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role = 'parent'`).bind(id).first()
  if (!exists) return jsonResp({ error: '家长不存在' }, 404)
  await env.DB.prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`).bind(name, id).run()
  if (resetPassword) {
    const newPwd = String(resetPassword).trim()
    if (newPwd.length < 6) return jsonResp({ error: '新密码至少 6 位' }, 400)
    const hash = await sha256(newPwd)
    await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_pwd = 1 WHERE id = ?`).bind(hash, id).run()
  }
  if (Array.isArray(studentIds)) {
    await env.DB.prepare(`DELETE FROM parent_links WHERE parent_id = ?`).bind(id).run()
    for (const sid of studentIds) {
      await env.DB.prepare(`INSERT OR IGNORE INTO parent_links (id, parent_id, student_id) VALUES (?, ?, ?)`)
        .bind('PL_' + randomToken().slice(0, 10), id, sid).run()
    }
  }
  return jsonResp({ success: true })
}

// 删除家长（教师/管理员，级联 parent_links）
async function handleDeleteParent(request, env, actor, id) {
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role = 'parent'`).bind(id).first()
  if (!exists) return jsonResp({ error: '家长不存在' }, 404)
  await env.DB.prepare(`DELETE FROM parent_links WHERE parent_id = ?`).bind(id).run()
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run()
  return jsonResp({ success: true })
}

async function handleLogin(request, env) {
  const { account, password } = await request.json()
  if (!account || !password) return jsonResp({ error: '请输入账号和密码' }, 400)

  const user = await env.DB.prepare(
    `SELECT id, account, password_hash, role, name, class_name, must_change_pwd
     FROM users WHERE account = ?`
  ).bind(account).first()

  if (!user) return jsonResp({ error: '账号不存在' }, 401)
  const hash = await sha256(password)
  if (hash !== user.password_hash) return jsonResp({ error: '密码错误' }, 401)

  const token = randomToken()
  const sessionUser = {
    id: user.id, name: user.name, role: user.role,
    className: user.class_name, mustChangePwd: !!user.must_change_pwd
  }
  await env.SESSIONS.put(
    `session:${token}`, JSON.stringify(sessionUser),
    { expirationTtl: 7 * 24 * 3600 }
  )

  return jsonResp({ success: true, token, role: user.role, user: sessionUser })
}

async function handleLogout(request, env) {
  const token = extractToken(request)
  if (token) await env.SESSIONS.delete(`session:${token}`)
  return jsonResp({ success: true })
}

async function handleMe(request, env) {
  const user = await authenticate(request, env)
  if (!user) return jsonResp({ error: '未登录' }, 401)
  return jsonResp({ user })
}

async function handleChangePassword(request, env, user) {
  const { oldPassword, newPassword } = await request.json()
  if (!oldPassword || !newPassword) return jsonResp({ error: '请填写原密码和新密码' }, 400)
  if (String(newPassword).length < 6) return jsonResp({ error: '新密码至少 6 位' }, 400)

  const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(user.id).first()
  if (!row) return jsonResp({ error: '用户不存在' }, 404)
  if ((await sha256(oldPassword)) !== row.password_hash) {
    return jsonResp({ error: '原密码不正确' }, 400)
  }

  const newHash = await sha256(newPassword)
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, must_change_pwd = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(newHash, user.id).run()

  const updated = { ...user, mustChangePwd: false }
  await env.SESSIONS.put(`session:${extractToken(request)}`, JSON.stringify(updated), {
    expirationTtl: 7 * 24 * 3600
  })

  return jsonResp({ success: true })
}

async function handleCreateTeacher(request, env, admin) {
  const { account, name, password, role, className } = await request.json()
  if (!account || !name || !password || !className) {
    return jsonResp({ error: '工号、姓名、初始密码、班级均为必填' }, 400)
  }
  const r = (role === 'admin') ? 'admin' : 'teacher'
  if (account === 'admin' && r !== 'admin') {
    return jsonResp({ error: '保留账号名不可用' }, 400)
  }

  const normalizedClass = normalizeClassName(className)
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE account = ?`).bind(account).first()
  if (exists) return jsonResp({ error: '该工号已存在' }, 409)

  const hash = await sha256(password)
  await env.DB.prepare(
    `INSERT INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?)`
  ).bind(account, account, hash, r, name, normalizedClass, admin.id).run()

  return jsonResp({
    success: true,
    user: { id: account, account, name, role: r, className: normalizedClass, status: 'active', mustChangePwd: true }
  })
}

async function handleListTeachers(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, account, name, role, class_name, status, created_at
     FROM users WHERE role IN ('teacher','admin') ORDER BY role DESC, id`
  ).all()
  return jsonResp(results)
}

async function handleRegister(request, env) {
  const { code, account, name, password, className } = await request.json()
  if (!code || !account || !name || !password) return jsonResp({ error: '邀请码、工号、姓名、密码均为必填' }, 400)
  if (String(password).length < 6) return jsonResp({ error: '密码至少 6 位' }, 400)

  const inv = await env.DB.prepare(`SELECT * FROM invite_codes WHERE code = ?`).bind(code).first()
  if (!inv) return jsonResp({ error: '邀请码无效' }, 400)
  if (inv.used) return jsonResp({ error: '邀请码已被使用' }, 400)
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return jsonResp({ error: '邀请码已过期' }, 400)

  const r = inv.role === 'admin' ? 'admin' : 'teacher'
  const cls = (className && String(className).trim()) || inv.class_name || ''
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE account = ?`).bind(account).first()
  if (exists) return jsonResp({ error: '该工号已存在' }, 409)

  const hash = await sha256(password)
  await env.DB.prepare(
    `INSERT INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?)`
  ).bind(account, account, hash, r, name, cls || null, 'invite:' + code).run()

  if (cls) {
    await env.DB.prepare(`INSERT OR IGNORE INTO classrooms (id, name, owner_id) VALUES (?, ?, ?)`)
      .bind('C_' + cls, cls, account).run()
  }

  await env.DB.prepare(`UPDATE invite_codes SET used = 1, used_by = ?, used_at = datetime('now') WHERE code = ?`)
    .bind(account, code).run()

  const token = randomToken()
  const sessionUser = { id: account, name, role: r, className: cls, mustChangePwd: true }
  await env.SESSIONS.put(`session:${token}`, JSON.stringify(sessionUser), { expirationTtl: 7 * 24 * 3600 })
  return jsonResp({ success: true, token, role: r, user: sessionUser })
}

async function handleCreateInviteCodes(request, env, admin) {
  const { role = 'teacher', className, count = 1, expiresInDays = 30 } = await request.json()
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 20)
  const r = role === 'admin' ? 'admin' : 'teacher'
  const expires = new Date(Date.now() + expiresInDays * 864e5).toISOString()
  const codes = []
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = randomToken().slice(0, 8).toUpperCase()
      try {
        await env.DB.prepare(
          `INSERT INTO invite_codes (id, code, role, class_name, created_by, used, expires_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`
        ).bind('IC_' + randomToken().slice(0, 12), c, r, className || null, admin.id, expires).run()
        codes.push(c)
        break
      } catch { /* 唯一冲突重试 */ }
    }
  }
  return jsonResp({ success: true, codes })
}

async function handleListInviteCodes(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT code, role, class_name, used, used_by, created_at, expires_at FROM invite_codes ORDER BY created_at DESC`
  ).all()
  return jsonResp(results)
}

async function handleRevokeInviteCode(request, env, code) {
  await env.DB.prepare(`DELETE FROM invite_codes WHERE code = ? AND used = 0`).bind(code).run()
  return jsonResp({ success: true })
}

async function handleCreateParent(request, env, user) {
  const { account, name, password, studentIds } = await request.json()
  if (!account || !name || !password) return jsonResp({ error: '账号、姓名、密码均为必填' }, 400)
  if (String(password).length < 6) return jsonResp({ error: '密码至少 6 位' }, 400)

  const exists = await env.DB.prepare(`SELECT id FROM users WHERE account = ?`).bind(account).first()
  if (exists) return jsonResp({ error: '该账号已存在' }, 409)

  const hash = await sha256(password)
  await env.DB.prepare(
    `INSERT INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by)
     VALUES (?, ?, ?, 'parent', ?, NULL, 'active', 1, ?)`
  ).bind(account, account, hash, name, user.id).run()

  for (const sid of (Array.isArray(studentIds) ? studentIds : [])) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO parent_links (id, parent_id, student_id) VALUES (?, ?, ?)`
    ).bind('PL_' + randomToken().slice(0, 10), account, sid).run()
  }
  return jsonResp({ success: true, user: { id: account, account, name } })
}

async function handleListParents(request, env) {
  const { results: parents } = await env.DB.prepare(
    `SELECT id, account, name FROM users WHERE role = 'parent' ORDER BY name`
  ).all()
  const out = []
  for (const p of parents) {
    const { results: links } = await env.DB.prepare(
      `SELECT u.id, u.name, u.class_name FROM parent_links pl JOIN users u ON u.id = pl.student_id WHERE pl.parent_id = ?`
    ).bind(p.id).all()
    out.push({ id: p.id, account: p.account, name: p.name, children: links })
  }
  return jsonResp(out)
}

async function handleLinkParent(request, env, user) {
  const { parentId, studentId } = await request.json()
  if (!parentId || !studentId) return jsonResp({ error: '缺少参数' }, 400)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO parent_links (id, parent_id, student_id) VALUES (?, ?, ?)`
  ).bind('PL_' + randomToken().slice(0, 10), parentId, studentId).run()
  return jsonResp({ success: true })
}

async function handleParentChildren(request, env, user) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.class_name FROM parent_links pl JOIN users u ON u.id = pl.student_id WHERE pl.parent_id = ? ORDER BY u.class_name, u.id`
  ).bind(user.id).all()
  return jsonResp(results)
}

async function handleParentStudent(request, env, user, studentId) {
  const link = await env.DB.prepare(
    `SELECT 1 FROM parent_links WHERE parent_id = ? AND student_id = ?`
  ).bind(user.id, studentId).first()
  if (!link) return jsonResp({ error: '无权查看该学生' }, 403)
  const student = await dbGetStudent(env, studentId)
  if (!student) return jsonResp({ error: '未找到该学生' }, 404)
  delete student.aiReport
  return jsonResp(student)
}

async function handleCreateStudent(request, env, teacher) {
  const { account, name, className, password } = await request.json()
  if (!account || !name || !className) {
    return jsonResp({ error: '学号、姓名、班级均为必填' }, 400)
  }
  const normalizedClass = normalizeClassName(className)
  // 「全部班级」只是筛选哨兵，不是真实班级；允许它落库就会产生
  // 既筛不出来、又污染所有班级视图的学生（线上已经出现过 48 条）
  if (!isRealClassName(normalizedClass)) {
    return jsonResp({ error: `班级名不能是「${CLASS_FILTER_ALL}」（那是筛选用的保留名），请填写真实班级` }, 400)
  }
  if (isCorruptClassName(normalizedClass)) {
    return jsonResp({ error: '班级名包含无法识别的字符，请重新输入或粘贴' }, 400)
  }
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE account = ?`).bind(account).first()
  if (exists) return jsonResp({ error: '该学号已存在' }, 409)

  const pwd = password && String(password).length >= 1 ? password : account
  const hash = await sha256(pwd)
  await env.DB.prepare(
    `INSERT INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by)
     VALUES (?, ?, ?, 'student', ?, ?, 'active', 1, ?)`
  ).bind(account, account, hash, name, normalizedClass, teacher.id).run()

  await env.DB.prepare(
    `INSERT OR IGNORE INTO classrooms (id, name, owner_id) VALUES (?, ?, ?)`
  ).bind('C_' + normalizedClass, normalizedClass, teacher.id).run()

  return jsonResp({
    success: true,
    user: { id: account, account, name, className: normalizedClass, status: 'active', mustChangePwd: true }
  })
}

async function handleFixClassNames(request, env) {
  try {
    const { results: users } = await env.DB.prepare(`SELECT id, role, class_name FROM users`).all()
    const fwRe = /[\uFF08\uFF09]/
    const fixedUsers = []
    const dirtyUsers = []
    for (const u of users) {
      // 哨兵 / 编码损坏的班级名：无法自动推断正确班级，只如实上报，由管理员决定删除或改班。
      // 只统计学生：教师/家长本来就可能没有班级，不该混进「待清理」里徒增噪音。
      if (u.role === 'student' && (!u.class_name || !isRealClassName(u.class_name) || isCorruptClassName(u.class_name))) {
        dirtyUsers.push({ id: u.id, class_name: u.class_name })
        continue
      }
      if (fwRe.test(u.class_name)) {
        const n = normalizeClassName(u.class_name)
        await env.DB.prepare(`UPDATE users SET class_name = ? WHERE id = ?`).bind(n, u.id).run()
        fixedUsers.push({ id: u.id, from: u.class_name, to: n })
      }
    }

    const { results: rooms } = await env.DB.prepare(`SELECT id, name FROM classrooms`).all()
    const fixedRooms = []
    const removedRooms = []
    const mergedRooms = []
    // 先把「已经是规范名」的行登记下来。这样把「一年级（1）班」改成「一年级(1)班」时，
    // 如果后者本来就存在，就知道该合并（删掉多出来的那一行），
    // 而不是改名造出两行同名班级（下拉框用 Set 去重看不出来，但库里会一直留着脏行）。
    const takenNames = new Set(
      (rooms || []).filter(r => r.name === normalizeClassName(r.name)).map(r => r.name)
    )
    for (const r of rooms || []) {
      // 班级表里的哨兵与乱码行直接删掉：它们不是班级，留着只会让下拉框变成乱码墙
      if (!isRealClassName(r.name) || isCorruptClassName(r.name)) {
        await env.DB.prepare(`DELETE FROM classrooms WHERE id = ?`).bind(r.id).run()
        removedRooms.push({ id: r.id, name: r.name })
        continue
      }
      const n = normalizeClassName(r.name)
      if (n === r.name) continue
      if (takenNames.has(n)) {
        // 规范名已被别的行占用 → 这行是重复登记，删掉即可
        await env.DB.prepare(`DELETE FROM classrooms WHERE id = ?`).bind(r.id).run()
        mergedRooms.push({ id: r.id, from: r.name, to: n })
        continue
      }
      await env.DB.prepare(`UPDATE classrooms SET name = ? WHERE id = ?`).bind(n, r.id).run()
      takenNames.add(n)
      fixedRooms.push({ id: r.id, from: r.name, to: n })
    }

    return jsonResp({
      success: true,
      fixedUsers, fixedRooms,
      removedRooms, mergedRooms,
      dirtyUsers,
      fixedUserCount: fixedUsers.length,
      fixedRoomCount: fixedRooms.length,
      removedRoomCount: removedRooms.length,
      mergedRoomCount: mergedRooms.length,
      dirtyUserCount: dirtyUsers.length
    })
  } catch (e) {
    return jsonResp({ error: 'fix failed: ' + e.message }, 500)
  }
}

async function handleImportStudents(request, env, teacher) {
  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }
  const list = Array.isArray(body.students) ? body.students : null
  if (!list || list.length === 0) {
    return jsonResp({ error: '没有可导入的学生数据' }, 400)
  }
  if (list.length > 2000) {
    return jsonResp({ error: `单次最多导入 2000 行（本次 ${list.length} 行），请把文件拆开分次导入` }, 400)
  }

  const fallbackClass = isRealClassName(teacher.className) ? normalizeClassName(teacher.className) : ''

  // ---------- 第一步：全量校验，一行都不写 ----------
  // 原实现是「边校验边写」，所以文件格式不对时会把一半脏数据写进库，
  // 事后只能靠人肉一条条删 —— 这正是本次线上事故的成因。
  // 现在校验不通过的行直接不写，并逐行回报原因，做到「要么全对，要么不动库」。
  const prepared = []
  const errors = []
  const seen = new Set()

  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {}
    const account = String(row.account ?? '').trim()
    const name = String(row.name ?? '').trim()

    // 班级优先取 CSV 里那一列；行内没填才回落到导入者自己的班级。
    // 关键修复：以前是 `className ignored - forced to teacher.className`，
    // 于是用管理员账号导入时，管理员的哨兵班级「全部班级」被复制到了
    // 每一条学生记录上，产生了 48 条既筛不出、又污染所有班级视图的脏数据。
    const rawClass = String(row.className ?? '').trim()
    const className = rawClass ? normalizeClassName(rawClass) : fallbackClass

    if (!account || !name) {
      errors.push({ row: i + 1, account, reason: '学号或姓名为空' })
      continue
    }
    if (!isRealClassName(className)) {
      errors.push({
        row: i + 1, account,
        reason: rawClass
          ? `班级名「${className}」不是有效班级（不能是「${CLASS_FILTER_ALL}」，那是筛选用的保留名）`
          : '缺少班级：CSV 里没填班级列，而你的账号也没有绑定班级'
      })
      continue
    }
    if (seen.has(account)) {
      errors.push({ row: i + 1, account, reason: '同一个文件里学号重复' })
      continue
    }
    seen.add(account)
    prepared.push({ row: i + 1, account, name, className, password: String(row.password ?? '').trim() })
  }

  // ---------- 第二步：一次查出已存在的学号（原本每人一条 SELECT）----------
  const existing = new Set()
  const allAccounts = [...seen]
  for (const chunk of chunksOf(allAccounts)) {
    const { results } = await env.DB.prepare(
      `SELECT account FROM users WHERE account IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all()
    for (const r of (results || [])) existing.add(r.account)
  }

  const toCreate = prepared.filter(p => !existing.has(p.account))
  const skipped = prepared.length - toCreate.length

  // ---------- 第三步：多行 VALUES 批量插入（原本每人两条 INSERT）----------
  // 每行 6 个绑定参数，按 90 上限分片 → 每批 15 行。
  const hashed = []
  const classNames = new Set()
  for (const p of toCreate) {
    const pwd = (p.password && p.password.length >= 1) ? p.password : p.account
    hashed.push({ ...p, hash: await sha256(pwd) })
    classNames.add(p.className)
  }

  let created = 0
  for (const chunk of chunksOf(hashed, 15)) {
    const values = chunk.map(() => `(?, ?, ?, 'student', ?, ?, 'active', 1, ?)`).join(', ')
    const binds = []
    for (const r of chunk) binds.push(r.account, r.account, r.hash, r.name, r.className, teacher.id)
    try {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by)
         VALUES ${values}`
      ).bind(...binds).run()
      // 以数据库实际写入行数为准（OR IGNORE 会跳过并发冲突的行）
      const changed = Number(res?.meta?.changes)
      created += Number.isFinite(changed) ? changed : chunk.length
    } catch (e) {
      for (const r of chunk) {
        errors.push({ row: r.row, account: r.account, reason: '写入失败: ' + e.message })
      }
    }
  }

  // 班级表补登记：原本每人一条，现在每个班级一条
  for (const cn of classNames) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO classrooms (id, name, owner_id) VALUES (?, ?, ?)`
      ).bind('C_' + cn, cn, teacher.id).run()
    } catch { /* 班级表可能不存在，不影响学生导入 */ }
  }

  return jsonResp({ success: true, created, skipped, errors, total: list.length })
}

async function handleListClassrooms(request, env, user) {
  if (user.role === 'admin') {
    // 管理员看到的是「班级表 ∪ 学生实际所在班级」。
    // 只读 classrooms 表不够：历史上批量导入的学生不会登记到该表，
    // 于是真实存在的班反而在下拉框里选不到。
    const names = new Set()
    const { results: rooms } = await env.DB.prepare(`SELECT name FROM classrooms`).all()
    for (const r of (rooms || [])) names.add(r.name)
    const { results: used } = await env.DB.prepare(
      `SELECT DISTINCT class_name FROM users WHERE role = 'student' AND class_name IS NOT NULL`
    ).all()
    for (const r of (used || [])) names.add(r.class_name)

    // 过滤掉筛选哨兵与编码损坏的垃圾名（现网 classrooms 里混进了 GBK↔UTF-8 误码），
    // 否则下拉框会变成一片乱码，选谁都对不上。
    return jsonResp(
      [...names]
        .filter(n => isRealClassName(n) && !isCorruptClassName(n))
        .sort((a, b) => String(a).localeCompare(String(b), 'zh'))
    )
  }
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT class_name FROM users WHERE role='student' AND class_name = ?`
  ).bind(user.className).all()
  return jsonResp(results.map(r => r.class_name).filter(n => isRealClassName(n)))
}

// ===== 学科成绩分析（班级概览）=====
// 设计约束（沿用本项目踩过的两个坑）：
// ① 聚合全部下推到 SQL。绝不能「把全班成绩取回前端再算」——那是大结果集，
//    人数一多就撞 Cloudflare 的 CPU/内存上限，表现为 503（dbGetStudents 的老病）。
//    这里固定 4 条聚合查询，条数与学生数、成绩条数都无关。
// ② 班级过滤用 JOIN users 完成，而不是「先查 id 列表再 IN (...)」：
//    后者要 chunksOf 分片、还要防 D1 的 100 参数上限，前者一条 SQL 就干净。
// ③ 只读接口也必须限教师/管理员：班级层面的横向对比属于管理数据，
//    学生端可见就等于把全班成绩公开（与 /students 的信息隔离规则一致）。
const SCORE_PASS = 60        // 及格线
const SCORE_GOOD = 70        // 良好线
const SCORE_EXCELLENT = 85   // 优秀线

async function handleGetSubjectAnalysis(request, env, user, url) {
  // 范围：管理员可用 ?class= 选班（空 / 哨兵 = 全部班级）；
  // 教师只看自己的班，**忽略 query**，避免改 URL 越权看别的班。
  let scopeClass = null
  if (user.role === 'admin') {
    const n = normalizeClassName(url.searchParams.get('class') || '')
    scopeClass = isRealClassName(n) ? n : null
  } else {
    const n = normalizeClassName(user.className || '')
    scopeClass = isRealClassName(n) ? n : null
  }

  const where = scopeClass ? `u.class_name = ?` : `1 = 1`
  const args = scopeClass ? [scopeClass] : []

  // 班级总人数（分母：用于「覆盖率」——有多少人还没成绩）
  let scopeStudents = 0
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS students FROM users u WHERE u.role = 'student' AND ${where}`
    ).bind(...args).first()
    scopeStudents = row ? row.students : 0
  } catch { scopeStudents = 0 }

  // ① 各学科汇总 + 达标分布（分档阈值与前端图例一一对应）
  //    注意：分布按「成绩记录（人次）」计数，不是按人头 —— 一个人在 4 场考试
  //    里就有 4 条记录。UI 上必须写「人次」，否则教师会把「不及格 8」读成 8 个人。
  let subjectRows = []
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.subject AS subject,
              COUNT(*) AS records,
              COUNT(DISTINCT s.student_id) AS students,
              ROUND(AVG(s.score), 1) AS avg,
              MAX(s.score) AS max,
              MIN(s.score) AS min,
              SUM(CASE WHEN s.score >= ${SCORE_EXCELLENT} THEN 1 ELSE 0 END) AS excellent,
              SUM(CASE WHEN s.score >= ${SCORE_GOOD} AND s.score < ${SCORE_EXCELLENT} THEN 1 ELSE 0 END) AS good,
              SUM(CASE WHEN s.score >= ${SCORE_PASS} AND s.score < ${SCORE_GOOD} THEN 1 ELSE 0 END) AS pass,
              SUM(CASE WHEN s.score < ${SCORE_PASS} THEN 1 ELSE 0 END) AS poor
       FROM scores s
       JOIN users u ON u.id = s.student_id
       WHERE u.role = 'student' AND ${where}
       GROUP BY s.subject`
    ).bind(...args).all()
    subjectRows = results || []
  } catch { subjectRows = [] }

  // ② 考试清单：参与人数与科目数。
  //    scores 表没有考试日期列，只有自增 id；用 MIN(id) 排序 == 首次录入顺序，
  //    与 dbGetStudent / ScoreTrendChart 依赖的「插入次序」语义保持一致。
  let examRows = []
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.exam_name AS exam,
              COUNT(*) AS records,
              COUNT(DISTINCT s.student_id) AS students,
              COUNT(DISTINCT s.subject) AS subjects,
              MIN(s.id) AS first_id
       FROM scores s
       JOIN users u ON u.id = s.student_id
       WHERE u.role = 'student' AND ${where}
       GROUP BY s.exam_name
       ORDER BY first_id`
    ).bind(...args).all()
    examRows = results || []
  } catch { examRows = [] }

  // ③ 学科 × 考试 的平均分：趋势线的数据源
  let cellRows = []
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.exam_name AS exam,
              s.subject AS subject,
              ROUND(AVG(s.score), 1) AS avg,
              COUNT(DISTINCT s.student_id) AS students
       FROM scores s
       JOIN users u ON u.id = s.student_id
       WHERE u.role = 'student' AND ${where}
       GROUP BY s.exam_name, s.subject`
    ).bind(...args).all()
    cellRows = results || []
  } catch { cellRows = [] }

  // 按考试名归拢趋势点，前端按 exam 名对齐到 x 轴
  const pointsBySubject = new Map()
  for (const c of cellRows) {
    if (!pointsBySubject.has(c.subject)) pointsBySubject.set(c.subject, [])
    pointsBySubject.get(c.subject).push({ exam: c.exam, avg: c.avg, students: c.students })
  }

  const subjects = subjectRows
    .map(r => {
      const records = r.records || 0
      return {
        subject: r.subject,
        records,
        students: r.students || 0,
        avg: r.avg,
        max: r.max,
        min: r.min,
        dist: {
          excellent: r.excellent || 0,
          good: r.good || 0,
          pass: r.pass || 0,
          poor: r.poor || 0
        },
        passRate: records ? Math.round(((records - (r.poor || 0)) / records) * 1000) / 1000 : 0,
        excellentRate: records ? Math.round(((r.excellent || 0) / records) * 1000) / 1000 : 0,
        byExam: pointsBySubject.get(r.subject) || []
      }
    })
    .sort((a, b) => (b.avg || 0) - (a.avg || 0))

  return jsonResp({
    scope: {
      class: scopeClass,
      label: scopeClass || CLASS_FILTER_ALL,
      studentCount: scopeStudents
    },
    thresholds: { pass: SCORE_PASS, good: SCORE_GOOD, excellent: SCORE_EXCELLENT },
    exams: examRows.map(e => ({
      exam: e.exam,
      records: e.records || 0,
      students: e.students || 0,
      subjects: e.subjects || 0
    })),
    subjects,
    recordCount: subjectRows.reduce((a, r) => a + (r.records || 0), 0)
  })
}

// ---- AI 报告：把档案压成「给模型看」的摘要 ----
//
// 成绩记录里的 _images 是附件的 base64 dataURL（单张上限 1MB），_ids 是行主键。
// 两者对模型毫无意义，但 JSON.stringify 会把它们原样塞进提示词 —— 几个附件就能把
// 请求体顶到几十 MB，既烧 token 又可能撞上平台/网关的体积与时长限制
// （用户侧表现为一个没有任何错误详情的 502）。所以摘要必须显式剥掉 _ 前缀字段。
function aiProfileSummary(student) {
  const exams = (student.scores || []).map(exam => {
    const row = { 考试: exam.exam }
    for (const [k, v] of Object.entries(exam)) {
      if (k === 'exam' || k.startsWith('_')) continue
      row[k] = v
    }
    const imgs = exam._images || {}
    const n = Object.values(imgs).reduce((a, arr) => a + (Array.isArray(arr) ? arr.length : 0), 0)
    if (n) row.附件张数 = n          // 只报张数，不报内容
    return row
  })
  return {
    姓名: student.name,
    班级: student.className,
    成绩记录: exams,
    作业情况: student.homework,
    作业明细: (student.homeworkDetail || []).slice(0, 10),
    课堂行为: student.behavior,
    // 事件里可能挂着图片附件（base64 dataURL，单张上限 1MB）。原样 JSON.stringify
    // 会把提示词顶到几十 MB —— 和 scores._images 是同一类事故：附件只报张数，不报内容。
    重要事件: (student.events || []).slice(0, 20).map(e => {
      const row = { 日期: e.date, 类型: e.type, 内容: e.content }
      const n = Array.isArray(e.images) ? e.images.length : 0
      if (n) row.附件张数 = n
      return row
    })
  }
}

// 上游 AI 网关调用：带超时 + 对限流/5xx 退避重试一次。
//
// 两个刻意的选择：
//   1) 必须给 signal。不带超时的话，上游卡住时请求会一直挂着，最后被平台掐掉 ——
//      前端拿到的是一个没有 error 字段的 HTML 错误页，界面上只剩一句「请求失败: 502」，
//      既定位不到原因，也没法给用户任何可行提示。
//   2) 429 要退避重试。免费额度按并发/频率限流，隔一秒半再试往往就过了；
//      实测连续生成时第 3 次起就全是 429。
const AI_TIMEOUT_MS = 25000

async function callAIUpstream(env, messages) {
  const base = String(env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, '')
  const once = async () => {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AGNES_API_KEY ? { Authorization: `Bearer ${env.AGNES_API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: env.AGNES_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS)
    })
    if (resp.ok) return { ok: true, data: await resp.json() }
    // 上游的错误体里有可读原因（如 "Invalid token" / 额度用尽），尽量带出来
    let hint = ''
    try {
      const text = await resp.text()
      try { hint = JSON.parse(text)?.error?.message || '' } catch { hint = text.slice(0, 180) }
    } catch {}
    return { ok: false, status: resp.status, hint }
  }

  let r = await once()
  if (!r.ok && (r.status === 429 || r.status >= 500)) {
    await new Promise(res => setTimeout(res, 1500))
    r = await once()
  }
  return r
}

async function handleAIReport(request, env, user) {
  let studentId = ''
  try { ({ studentId } = await request.json()) } catch { return jsonResp({ error: '请求体格式有误' }, 400) }
  if (!studentId) return jsonResp({ error: '缺少学生 ID' }, 400)

  // 权限：教师/管理员可生成；学生仅限本人。
  // 家长端本来就不展示 AI 报告（handleParentStudent 已在服务端剔除该字段），
  // 所以这里直接拒绝 —— 否则任何已登录账号都能拿别班学号白嫖 AI 额度。
  if (user.role === 'student') {
    if (user.id !== studentId) return jsonResp({ error: '无权查看其他学生档案' }, 403)
  } else if (user.role !== 'teacher' && user.role !== 'admin') {
    return jsonResp({ error: '需要教师或管理员权限' }, 403)
  }

  const student = await dbGetStudent(env, studentId)
  if (!student) return jsonResp({ error: '未找到该学生' }, 404)
  if (teacherOutOfScope(user, student.className)) {
    return jsonResp({ error: '无权操作其他班级学生的报告' }, 403)
  }

  const AI_SYSTEM_PROMPT = `你是一位资深的班主任兼学习分析师。请根据学生的学业数据、课堂行为数据和历史事件，生成一份个性化的成长档案报告。

要求：
1. 严格基于提供的数据分析，不编造数据
2. 语言温暖但客观，避免空话套话
3. 关注学生的进步趋势和潜在风险
4. 建议要具体可执行，不要笼统的"努力学习"
5. 家校沟通话术要口语化，适合直接发给家长

请严格按照以下 JSON 格式输出（不要包含 markdown 代码块标记，直接输出 JSON）：
{
  "profile": "学生整体画像，2-3句话概括趋势和特点",
  "weaknesses": [{ "subject": "科目或方面", "reason": "具体问题描述，含数据引用" }],
  "suggestions": ["具体可执行的建议1", "建议2", "建议3"],
  "talkScript": "给家长的一段话，口语化，100字以内"
}`

  const dataSummary = aiProfileSummary(student)

  // 失败时兜底：已经生成过的报告，比一句报错有用得多
  const cached = student.aiReport
  const giveUp = (status, message) => cached
    ? jsonResp({ ...cached, _source: 'cached', _error: message })
    : jsonResp({ error: message }, status)

  let upstream
  try {
    upstream = await callAIUpstream(env, [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: `请根据以下学生数据生成成长档案报告：\n\n${JSON.stringify(dataSummary, null, 2)}` }
    ])
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    return giveUp(504, timedOut
      ? `AI 服务响应超时（超过 ${AI_TIMEOUT_MS / 1000} 秒），请稍后重试`
      : 'AI 服务连接失败: ' + err.message)
  }

  if (!upstream.ok) {
    // 限流要说人话：这是「等一会儿再来」，不是「系统坏了」。
    // 同时把上游自己的原文带出来 —— 免费额度有「并发限流」与「额度耗尽」两种，
    // 前者等一会就好，后者只能去账单/套餐里解决，光看 429 分不清是哪一种。
    if (upstream.status === 429) {
      const why = upstream.hint ? `（上游：${upstream.hint}）` : ''
      return giveUp(429, 'AI 服务当前请求过多或额度已用尽，请稍后重试' + why)
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return giveUp(502, 'AI 服务鉴权失败，请检查 AGNES_API_KEY 配置')
    }
    return giveUp(502, `AI 服务返回 ${upstream.status}${upstream.hint ? '：' + upstream.hint : ''}`)
  }

  const data = upstream.data
  let content = (data.choices?.[0]?.message?.content || '').trim()
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  let report
  try { report = JSON.parse(content) }
  catch { report = { profile: content, weaknesses: [], suggestions: [], talkScript: '', _parseError: true } }

  // 一个学生只保留最新一份报告。读的时候是 ORDER BY generated_at DESC LIMIT 1，
  // 旧实现每次生成都 INSERT，旧行纯属死数据（线上已经堆了多条）。
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM ai_reports WHERE student_id = ?`).bind(studentId),
      env.DB.prepare(`INSERT INTO ai_reports (student_id, report_json) VALUES (?, ?)`)
        .bind(studentId, JSON.stringify(report))
    ])
  } catch (e) {
    // 落库失败不该把刚生成的报告扔掉 —— 照常返回，只是下次还得再生成一次
    return jsonResp({ ...report, _source: 'ai', _persistError: e.message })
  }

  return jsonResp({ ...report, _source: 'ai' })
}

// ===== 单条成绩：增 / 改 / 删 =====
//
// 三个动作共用一套前置校验，所以抽成 loadScoreTarget：
//   学生存在 → 教师在不在自己班里 → （可选）这条成绩属于这个学生。
// 必须走学生这一层判断 —— scores 表只有 student_id，没有 class_name，
// 成绩行的「班级归属」只能由所属学生推出来。
// 少了这一步，任何教师改一下 URL 里的学号就能篡改别班的成绩。
async function loadScoreTarget(env, teacher, studentId, scoreId) {
  const student = await env.DB.prepare(
    `SELECT id, name, class_name FROM users WHERE id = ? AND role = 'student'`
  ).bind(studentId).first()
  if (!student) return { response: jsonResp({ error: '学生不存在' }, 404) }
  if (teacherOutOfScope(teacher, student.class_name)) {
    return { response: jsonResp({ error: '无权操作其他班级学生的成绩' }, 403) }
  }
  if (scoreId === undefined || scoreId === null || scoreId === '') return { student }

  const row = await env.DB.prepare(
    `SELECT id, exam_name, subject, score FROM scores WHERE id = ? AND student_id = ?`
  ).bind(scoreId, studentId).first()
  if (!row) return { response: jsonResp({ error: '成绩记录不存在' }, 404) }
  return { student, row }
}

// 分数：允许小数（87.5 这种半分很常见），但必须是有穷数且不荒谬。
// 刻意不写死「0–100」上限 —— 150 分制试卷、体育按 1000 分计分的学校都真实存在，
// 卡死上限会把合法数据挡在门外；这里只拦明显是误输入的（负数 / 四位数 / 非数字）。
// 前端另有一层「0–100 之外标黄提醒」，那是提示，不是拒绝。
const SCORE_MAX = 1000
function normalizeScore(v) {
  const raw = typeof v === 'number' ? v : String(v ?? '').trim()
  if (raw === '') return { error: '分数不能为空' }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { error: '分数必须是数字' }
  if (n < 0) return { error: '分数不能为负数' }
  if (n > SCORE_MAX) return { error: `分数不能超过 ${SCORE_MAX}` }
  // 去掉浮点噪声（0.1+0.2 那一类），保留一位小数
  return { value: Math.round(n * 10) / 10 }
}

function normalizeExamName(v) {
  const s = String(v ?? '').trim()
  if (!s) return { error: '考试名称不能为空' }
  if (s.length > 40) return { error: '考试名称过长（最多 40 个字）' }
  return { value: s }
}

function normalizeSubject(v) {
  const s = String(v ?? '').trim()
  if (!s) return { error: '科目不能为空' }
  if (s.length > 20) return { error: '科目名过长（最多 20 个字）' }
  return { value: s }
}

// scores 上有 UNIQUE(student_id, exam_name, subject)：把一条成绩改名/改科目时，
// 很容易撞上同一次考试的同一科目。撞了就让数据库抛约束错误的话，前端只会看到 500，
// 教师完全不知道发生了什么。所以在写入前先查出来，把冲突讲清楚。
async function findScoreClash(env, studentId, examName, subject, excludeId) {
  const row = await env.DB.prepare(
    `SELECT id FROM scores WHERE student_id = ? AND exam_name = ? AND subject = ? AND id != ?`
  ).bind(studentId, examName, subject, excludeId ?? -1).first()
  return row || null
}

// 新增成绩（教师/管理员）
async function handleAddScore(request, env, teacher, studentId) {
  const loaded = await loadScoreTarget(env, teacher, studentId)
  if (loaded.response) return loaded.response

  const body = await request.json().catch(() => ({}))
  const exam = normalizeExamName(body.exam_name)
  if (exam.error) return jsonResp({ error: exam.error }, 400)
  const subject = normalizeSubject(body.subject)
  if (subject.error) return jsonResp({ error: subject.error }, 400)
  const score = normalizeScore(body.score)
  if (score.error) return jsonResp({ error: score.error }, 400)

  const imagesJson = Array.isArray(body.images) ? JSON.stringify(body.images.slice(0, 3)) : '[]'

  // 同一场考试的同一科目只保留一条（唯一约束 + INSERT OR REPLACE = 覆盖更新）。
  // 这个「重复录入即改正」的行为要如实回报，否则教师以为自己又加了一条，
  // 回头看到科目数没变会以为系统没保存。
  const existing = await findScoreClash(env, studentId, exam.value, subject.value, null)

  await env.DB.prepare(
    `INSERT OR REPLACE INTO scores (student_id, exam_name, subject, score, images) VALUES (?, ?, ?, ?, ?)`
  ).bind(studentId, exam.value, subject.value, score.value, imagesJson).run()

  return jsonResp({ success: true, replaced: !!existing, score: score.value })
}

// 修改单条成绩（教师/管理员）
// body 里没给的字段保持原值；images 显式传了才替换（传 [] 表示清空附件）。
async function handleUpdateScore(request, env, teacher, studentId, scoreId) {
  const loaded = await loadScoreTarget(env, teacher, studentId, scoreId)
  if (loaded.response) return loaded.response
  const { row } = loaded

  const body = await request.json().catch(() => ({}))
  const exam = normalizeExamName(body.exam_name ?? row.exam_name)
  if (exam.error) return jsonResp({ error: exam.error }, 400)
  const subject = normalizeSubject(body.subject ?? row.subject)
  if (subject.error) return jsonResp({ error: subject.error }, 400)
  const score = normalizeScore(body.score ?? row.score)
  if (score.error) return jsonResp({ error: score.error }, 400)

  let imagesJson = null
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) return jsonResp({ error: '附件格式不正确' }, 400)
    if (body.images.length > 3) return jsonResp({ error: '附件最多 3 张' }, 400)
    imagesJson = JSON.stringify(body.images)
  }

  const clash = await findScoreClash(env, studentId, exam.value, subject.value, scoreId)
  if (clash) {
    return jsonResp({
      error: `该学生「${exam.value}」下已有「${subject.value}」成绩，请直接修改那一条，或换一个科目／考试名称`,
      conflictId: clash.id
    }, 409)
  }

  if (imagesJson === null) {
    await env.DB.prepare(
      `UPDATE scores SET exam_name = ?, subject = ?, score = ? WHERE id = ? AND student_id = ?`
    ).bind(exam.value, subject.value, score.value, scoreId, studentId).run()
  } else {
    await env.DB.prepare(
      `UPDATE scores SET exam_name = ?, subject = ?, score = ?, images = ? WHERE id = ? AND student_id = ?`
    ).bind(exam.value, subject.value, score.value, imagesJson, scoreId, studentId).run()
  }

  return jsonResp({ success: true, scoreId: Number(scoreId) })
}

// 删除单条成绩（教师/管理员）
// 只删这一条记录，不碰其它科目 —— 录错一科不该让整场考试消失。
async function handleDeleteScore(request, env, teacher, studentId, scoreId) {
  const loaded = await loadScoreTarget(env, teacher, studentId, scoreId)
  if (loaded.response) return loaded.response
  await env.DB.prepare(
    `DELETE FROM scores WHERE id = ? AND student_id = ?`
  ).bind(scoreId, studentId).run()
  return jsonResp({ success: true, removed: loaded.row })
}

// ===== 成长事件：增 / 删（教师/管理员） =====

// 一条成长事件最多挂几张图。与成绩附件的上限（src/utils/imageCompress.js 的 MAX_IMAGES）
// 刻意保持一致：两处规则不同，教师会先疑惑「成绩能放 3 张、记录为什么只能放 2 张」，
// 而且单行体积更容易顶到 D1 的行大小上限。
const MAX_EVENT_IMAGES = 3

// events.images 是后加的列 —— 线上库是项目早期在 D1 控制台手工建的，没有这一列。
// 这里做一次性惰性迁移（与 ensureHomeworkTables 同一套思路），部署者不必手工跑 SQL。
// 列已存在时 SQLite 抛 duplicate column name，那正是常态，直接吞掉。
let eventImagesEnsured = false
async function ensureEventImages(env) {
  if (eventImagesEnsured) return
  try {
    await env.DB.prepare(`ALTER TABLE events ADD COLUMN images TEXT DEFAULT '[]'`).run()
  } catch { /* 列已存在 */ }
  eventImagesEnsured = true
}

/** events 行 → 接口形状。坏附件数据退化成空数组，不让一条事件拖垮整份档案 */
function eventRow(r) {
  let images = []
  try {
    const parsed = JSON.parse(r.images || '[]')
    if (Array.isArray(parsed)) {
      images = parsed.filter(x => typeof x === 'string' && x).slice(0, MAX_EVENT_IMAGES)
    }
  } catch { images = [] }
  return { id: r.id, date: r.date, type: r.type, content: r.content, images }
}

// 读事件。两个调用点（整份档案、事件子资源）共用同一实现。
// 对「images 列还不存在」做降级：迁移没跑成功时，宁可时间线暂时少显示图片，
// 也不能让整份档案 500。
async function readEvents(env, studentId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, event_date as date, event_type as type, content, images
       FROM events WHERE student_id = ? ORDER BY event_date, id`
    ).bind(studentId).all()
    return (results || []).map(eventRow)
  } catch {
    const { results } = await env.DB.prepare(
      `SELECT id, event_date as date, event_type as type, content
       FROM events WHERE student_id = ? ORDER BY event_date, id`
    ).bind(studentId).all()
    return (results || []).map(eventRow)
  }
}

/** 校验请求体里的附件：必须是数组、最多 3 张、每张都是非空字符串。未提供时返回 null */
function normalizeEventImages(raw) {
  if (raw === undefined) return { images: null }
  if (!Array.isArray(raw)) return { error: '附件格式不正确' }
  if (raw.length > MAX_EVENT_IMAGES) return { error: `附件最多 ${MAX_EVENT_IMAGES} 张` }
  if (raw.some(x => typeof x !== 'string' || !x)) return { error: '附件内容不正确' }
  return { images: raw }
}

// 事件是写操作：教师只能动本班学生的。
// 旧实现只 requireTeacher、没有班级范围校验 —— 任何教师改一下 URL 里的学号，
// 就能往别班学生的时间线上写东西、或删掉别人的记录。
async function scopeCheckEventTarget(env, teacher, studentId) {
  const target = await env.DB.prepare(
    `SELECT id, class_name FROM users WHERE id = ? AND role = 'student'`
  ).bind(studentId).first()
  if (!target) return jsonResp({ error: '学生不存在' }, 404)
  if (teacherOutOfScope(teacher, target.class_name)) {
    return jsonResp({ error: '无权操作其他班级学生的记录' }, 403)
  }
  return null
}

async function handleAddEvent(request, env, teacher, studentId) {
  const denied = await scopeCheckEventTarget(env, teacher, studentId)
  if (denied) return denied

  const body = await request.json().catch(() => ({}))
  const { event_date, event_type, content } = body
  if (!event_date || !event_type || !content) return jsonResp({ error: '缺少参数' }, 400)

  const parsed = normalizeEventImages(body.images)
  if (parsed.error) return jsonResp({ error: parsed.error }, 400)
  const imagesJson = JSON.stringify(parsed.images || [])

  await ensureEventImages(env)
  try {
    await env.DB.prepare(
      `INSERT INTO events (student_id, event_date, event_type, content, images) VALUES (?, ?, ?, ?, ?)`
    ).bind(studentId, event_date, event_type, content, imagesJson).run()
  } catch (e) {
    // 迁移没生效（images 列还不存在）时退化成「不带图也能记一条」，
    // 而不是让教师看到一句「添加失败」却完全不知道原因。
    await env.DB.prepare(
      `INSERT INTO events (student_id, event_date, event_type, content) VALUES (?, ?, ?, ?)`
    ).bind(studentId, event_date, event_type, content).run()
  }
  return jsonResp({ success: true })
}

async function handleDeleteEvent(request, env, teacher, studentId) {
  const denied = await scopeCheckEventTarget(env, teacher, studentId)
  if (denied) return denied

  const url = new URL(request.url)

  // 优先按行主键删。回落到 (日期,类型,内容) 只是为了让老版本前端不至于报错 ——
  // 那条路会把「同一天、同类型、同内容」的两条记录一起删掉，所以只要前端给了 id 就不走它。
  const rawId = url.searchParams.get('id')
  const idNum = Number(rawId)
  if (rawId && Number.isInteger(idNum) && idNum > 0) {
    const r = await env.DB.prepare(
      `DELETE FROM events WHERE id = ? AND student_id = ?`
    ).bind(idNum, studentId).run()
    if (Number(r?.meta?.changes ?? 0) === 0) return jsonResp({ error: '未找到该条记录' }, 404)
    return jsonResp({ success: true, removed: idNum })
  }

  const event_date = url.searchParams.get('event_date')
  const event_type = url.searchParams.get('event_type')
  const content = url.searchParams.get('content')
  if (!event_date || !event_type || !content) return jsonResp({ error: '缺少参数' }, 400)
  const r = await env.DB.prepare(
    `DELETE FROM events WHERE student_id = ? AND event_date = ? AND event_type = ? AND content = ?`
  ).bind(studentId, event_date, event_type, content).run()
  if (Number(r?.meta?.changes ?? 0) === 0) return jsonResp({ error: '未找到该条记录' }, 404)
  return jsonResp({ success: true })
}

async function handleImportScores(request, env, teacher) {
  const { scores } = await request.json()
  if (!Array.isArray(scores) || scores.length === 0) {
    return jsonResp({ error: '没有可导入的成绩数据' }, 400)
  }

  let imported = 0, skipped = 0, errors = []

  for (let i = 0; i < scores.length; i++) {
    const row = scores[i]
    const studentId = String(row['学号'] || row['id'] || '').trim()
    const examName = String(row['考试名称'] || row['exam_name'] || row['考试'] || '').trim()
    const subject = String(row['科目'] || row['subject'] || '').trim()
    const score = parseFloat(row['分数'] || row['score'] || row['成绩'] || 0)

    if (!studentId || !examName || !subject || isNaN(score)) {
      errors.push({ row: i + 1, data: row, reason: '学号/考试名称/科目/分数 任一为空或无效' })
      continue
    }

    // 验证学生是否存在且在教师班级
    const student = await env.DB.prepare(
      `SELECT id FROM users WHERE id = ? AND role = 'student' AND class_name = ?`
    ).bind(studentId, teacher.className).first()
    if (!student) {
      errors.push({ row: i + 1, studentId, reason: '学生不存在或不在本班' })
      skipped++
      continue
    }

    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO scores (student_id, exam_name, subject, score) VALUES (?, ?, ?, ?)`
      ).bind(studentId, examName, subject, score).run()
      imported++
    } catch (e) {
      errors.push({ row: i + 1, studentId, reason: '写入失败: ' + e.message })
    }
  }

  return jsonResp({ success: true, imported, skipped, errors, total: scores.length })
}

// ===== 课堂行为评分编辑 =====
// 教师保存学生行为四维评分（0-5）：raise_hand 举手 / focus 专注 / cooperation 合作 / homework_quality 作业质量
async function handleUpdateBehavior(request, env, teacher, studentId) {
  // 学生必须存在
  const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role = 'student'`).bind(studentId).first()
  if (!target) return jsonResp({ error: '学生不存在' }, 404)

  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }

  // 验证并收集字段
  const fields = ['raise_hand', 'focus', 'cooperation', 'homework_quality']
  const values = {}
  for (const f of fields) {
    if (body[f] !== undefined) {
      const v = Number(body[f])
      if (isNaN(v) || v < 0 || v > 5) {
        return jsonResp({ error: f + ' 必须在 0-5 之间' }, 400)
      }
      values[f] = v
    }
  }
  if (Object.keys(values).length === 0) {
    return jsonResp({ error: '没有提供需要更新的字段' }, 400)
  }

  // UPSERT：如果存在则更新，否则插入
  const existing = await env.DB.prepare(
    `SELECT student_id FROM behavior WHERE student_id = ?`
  ).bind(studentId).first()

  if (existing) {
    await env.DB.prepare(`
      UPDATE behavior SET
        raise_hand = COALESCE(?, raise_hand),
        focus = COALESCE(?, focus),
        cooperation = COALESCE(?, cooperation),
        homework_quality = COALESCE(?, homework_quality),
        updated_at = datetime('now')
      WHERE student_id = ?
    `).bind(
      values.raise_hand ?? null,
      values.focus ?? null,
      values.cooperation ?? null,
      values.homework_quality ?? null,
      studentId
    ).run()
  } else {
    await env.DB.prepare(`
      INSERT INTO behavior (student_id, raise_hand, focus, cooperation, homework_quality)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      studentId,
      values.raise_hand ?? 0,
      values.focus ?? 0,
      values.cooperation ?? 0,
      values.homework_quality ?? 0
    ).run()
  }

  return jsonResp({ success: true })
}

// ===== 作业提交情况编辑 =====
// 教师录入/更新学生作业提交统计：total 应交次数，missed 未交次数，rate 由数据库计算
async function handleUpdateHomework(request, env, teacher, studentId) {
  const target = await env.DB.prepare(
    `SELECT id, name, class_name FROM users WHERE id = ? AND role = 'student'`
  ).bind(studentId).first()
  if (!target) return jsonResp({ error: '学生不存在' }, 404)

  // 班级范围：教师仅限本人班级（管理员、未设班级或「全部班级」的账号不受限）
  if (teacherOutOfScope(teacher, target.class_name)) {
    return jsonResp({
      error: `${target.name || '该学生'}不在你负责的班级（${target.class_name || '未设置'}），无法修改；管理员账号不受此限制`,
      code: 'CLASS_OUT_OF_SCOPE'
    }, 403)
  }

  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }

  const total = Number(body.total)
  const missed = Number(body.missed)
  if (!Number.isInteger(total) || total < 0) return jsonResp({ error: '应交次数必须是不小于 0 的整数' }, 400)
  if (!Number.isInteger(missed) || missed < 0) return jsonResp({ error: '未交次数必须是不小于 0 的整数' }, 400)
  if (missed > total) return jsonResp({ error: '未交次数不能超过应交次数' }, 400)

  try {
    // 统一走 writeHomeworkSummary：它知道 rate 在现网是生成列、不能写。
    const saved = await writeHomeworkSummary(env, studentId, total, missed)
    return jsonResp({ success: true, ...saved })
  } catch (e) {
    // 这里刻意把底层错误原文回传：本接口只有教师/管理员可调用，
    // 而写库失败时前端只能显示「请求失败: 500」，对排查毫无信息量。
    return jsonResp({ error: '保存失败：' + (e && e.message ? e.message : String(e)) }, 500)
  }
}

// ===== 作业明细模型（每次作业 × 每人提交状态）=====
// 解决的问题：汇总式 total/missed 只能回答「提交率多少」，
// 无法回答「这次作业谁没交」。明细模型以「一次作业」为粒度记录每个人的状态，
// 再把结果回写 homework 汇总表，使班级概览、家长端、AI 报告口径保持一致。
//
// 状态：submitted 已交 / late 补交 / missing 未交 / exempt 免交 / pending 待标记
// 提交率口径：已交 = submitted + late，应交 = 已交 + missing（pending/exempt 不计入分母）

const HOMEWORK_STATUSES = ['submitted', 'late', 'missing', 'exempt', 'pending']
const HW_STATUS_LABELS = { submitted: '已交', late: '补交', missing: '未交', exempt: '免交', pending: '待标记' }
const HW_STATUS_ALIASES = {
  'submitted': 'submitted', '已交': 'submitted', '提交': 'submitted', '已提交': 'submitted', '完成': 'submitted',
  '是': 'submitted', 'y': 'submitted', 'yes': 'submitted', '1': 'submitted', 'true': 'submitted',
  'late': 'late', '补交': 'late', '迟交': 'late', '补': 'late',
  'missing': 'missing', '未交': 'missing', '没交': 'missing', '缺交': 'missing', '未完成': 'missing',
  '否': 'missing', 'n': 'missing', 'no': 'missing', '0': 'missing', 'false': 'missing',
  'exempt': 'exempt', '免交': 'exempt', '免': 'exempt', '请假': 'exempt',
  'pending': 'pending', '待标记': 'pending', '未标记': 'pending'
}

function normalizeHomeworkStatus(v) {
  const raw = String(v ?? '').trim()
  const key = raw.toLowerCase()
  return HW_STATUS_ALIASES[key] ?? HW_STATUS_ALIASES[raw] ?? null
}

// 日期归一化：接受 2026/9/1、2026.9.1、2026-9-1 → 2026-09-01
function normalizeDate(v) {
  const s = String(v ?? '').trim().replace(/[.／/]/g, '-')
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function placeholders(n) {
  return new Array(n).fill('?').join(',')
}

// 建表：D1 没有迁移框架，采用「首次使用时建表」，
// 让新功能部署后零手工步骤即可用（建表语句同时归档在 schema/homework-detail.sql）
const HOMEWORK_DDL = [
  `CREATE TABLE IF NOT EXISTS homework_assignments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     class_name TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL,
     due_date TEXT NOT NULL,
     note TEXT DEFAULT '',
     created_by TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS homework_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     assignment_id INTEGER NOT NULL,
     student_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     note TEXT DEFAULT '',
     updated_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_asg_uniq ON homework_assignments (class_name, subject, title, due_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_rec_uniq ON homework_records (assignment_id, student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hw_rec_student ON homework_records (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hw_asg_class ON homework_assignments (class_name, due_date)`
]

let __hwTablesReady = false
async function ensureHomeworkTables(env) {
  if (__hwTablesReady) return
  for (const sql of HOMEWORK_DDL) {
    await env.DB.prepare(sql).run()
  }
  __hwTablesReady = true
}

// 汇总表的自愈 DDL。结构刻意与现网 homework 表保持一致：
// rate 用 STORED 生成列（口径单一，不可能与 total/missed 不一致），
// 于是「新库」和「现网库」走完全相同的代码路径，不会出现只在一边能跑的写法。
const HOMEWORK_SUMMARY_DDL = [
  `CREATE TABLE IF NOT EXISTS homework (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     student_id TEXT NOT NULL,
     total INTEGER NOT NULL DEFAULT 0,
     missed INTEGER NOT NULL DEFAULT 0,
     rate REAL GENERATED ALWAYS AS (
       CASE WHEN total > 0 THEN (total - missed) * 1.0 / total ELSE 0 END
     ) STORED,
     updated_at TEXT DEFAULT (datetime('now'))
   )`,
  // 一人一行。现网这张表没有唯一约束，一旦出现重复行，
  // 「按 student_id 取一行」就会变成随机取，因此补上并忽略失败（存量重复行时建不上）。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_summary_student ON homework (student_id)`
]

let __hwSummaryReady = false
// 写汇总前调用：保证 homework 表及其唯一索引存在（D1 没有迁移框架，采用首次使用时自愈）
async function ensureHomeworkSchema(env) {
  await ensureHomeworkTables(env)
  if (__hwSummaryReady) return
  for (const sql of HOMEWORK_SUMMARY_DDL) {
    try { await env.DB.prepare(sql).run() } catch { /* 索引可能因存量重复行建不上，不影响主流程 */ }
  }
  __hwSummaryReady = true
}

// 班级维度的可见范围：管理员可跨班（class= 空 → 全部），教师仅限本人班级
function resolveHomeworkScope(user, url) {
  const q = String(url.searchParams.get('class') || '').trim()
  if (user.role === 'admin') {
    return (!q || q === '全部班级') ? null : normalizeClassName(q)
  }
  return user.className ? normalizeClassName(user.className) : null
}

function assertHomeworkScope(user, className) {
  if (user.role === 'admin') return null
  if (normalizeClassName(user.className || '') !== normalizeClassName(className || '')) {
    return jsonResp({ error: '只能操作自己负责的班级' }, 403)
  }
  return null
}

async function dbGetClassStudents(env, className) {
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM users WHERE role = 'student' AND class_name = ? ORDER BY id`
  ).bind(className).all()
  return results || []
}

// ===== homework 汇总表写入（全项目唯一入口）=====
// 现网 homework 表的 rate 是 STORED 生成列（GENERATED ALWAYS AS (...) STORED），
// 由数据库计算，任何 UPDATE/INSERT 写入它都会直接抛错：
//   cannot UPDATE generated column "rate": SQLITE_ERROR [code: 7500]
// 这正是「教师保存作业提交率 → 请求失败: 500」的根因，而且它同时影响
// 明细点名回写、CSV 批量导入等所有写汇总的路径。
//
// 判定方式：SQLite 的 PRAGMA table_info 不列出生成列（生成的列只在 table_xinfo 里），
// 所以「列清单里有没有 rate」恰好可以区分：
//   有 rate → 普通列，需要我们自己写；
//   无 rate → 生成列（或该列不存在），绝不能写。
// 这样同一份代码在两种表结构上都是对的。
// 按库缓存：同一个 isolate 里可能拿到不同的 DB 绑定（如多环境/测试），
// 用 WeakMap 以 env.DB 为键，避免把 A 库的表结构套用到 B 库上。
const __hwSummaryShapeCache = new WeakMap()
async function homeworkSummaryShape(env) {
  const cached = env.DB ? __hwSummaryShapeCache.get(env.DB) : null
  if (cached) return cached

  let cols = []
  try {
    const { results } = await env.DB.prepare(`PRAGMA table_info(homework)`).all()
    cols = (results || []).map(r => String(r.name))
  } catch { cols = [] }

  let ddl = ''
  try {
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'homework'`
    ).first()
    ddl = row?.sql || ''
  } catch { ddl = '' }

  const listed = cols.includes('rate')
  const definedInDdl = /[(,\s]rate\s+[A-Za-z]/i.test(ddl)
  // 生成列不出现在 table_info 里（D1 与本地 SQLite 一致，已实测），
  // 所以「建表语句定义了 rate、列清单里却没有」= 它是生成列 → 绝不能写。
  const rateIsGenerated = !listed && definedInDdl

  const shape = {
    exists: cols.length > 0,
    hasRateColumn: listed && !rateIsGenerated,
    hasUpdatedAt: cols.includes('updated_at')
  }
  if (env.DB) __hwSummaryShapeCache.set(env.DB, shape)
  return shape
}

// 写入后回读，返回数据库里的真实值。
// rate 一律以数据库为准，不由服务端或前端自己算（两边算法一旦漂移就会显示不一致）。
async function writeHomeworkSummary(env, studentId, total, missed) {
  await ensureHomeworkSchema(env)
  const shape = await homeworkSummaryShape(env)
  const rate = total === 0 ? 0 : (total - missed) / total

  const sets = ['total = ?', 'missed = ?']
  const args = [total, missed]
  if (shape.hasRateColumn) { sets.push('rate = ?'); args.push(rate) }
  if (shape.hasUpdatedAt) sets.push(`updated_at = datetime('now')`)

  const upd = await env.DB.prepare(
    `UPDATE homework SET ${sets.join(', ')} WHERE student_id = ?`
  ).bind(...args, studentId).run()

  // 没有命中任何行才插入（不用 ON CONFLICT：现存表未必有 student_id 唯一索引）
  if (!(upd.meta && upd.meta.changes > 0)) {
    const cols = ['student_id', 'total', 'missed']
    const marks = ['?', '?', '?']
    const vals = [studentId, total, missed]
    if (shape.hasRateColumn) { cols.push('rate'); marks.push('?'); vals.push(rate) }
    await env.DB.prepare(
      `INSERT INTO homework (${cols.join(', ')}) VALUES (${marks.join(', ')})`
    ).bind(...vals).run()
  }

  const back = await env.DB.prepare(
    `SELECT total, missed, rate FROM homework WHERE student_id = ?`
  ).bind(studentId).first()

  return {
    total: back?.total ?? total,
    missed: back?.missed ?? missed,
    rate: back?.rate ?? rate
  }
}

// 兼容旧调用点：明细回写、CSV 导入都经由此函数写汇总
async function upsertHomeworkSummary(env, studentId, total, missed) {
  const saved = await writeHomeworkSummary(env, studentId, total, missed)
  return saved.rate
}

// homework 表能不能用 ON CONFLICT(student_id) 做 upsert，完全取决于
// 有没有 student_id 的唯一索引。现网这张表原本没有，索引由 ensureHomeworkSchema
// 在首次写入时补上；但存量重复行会让建索引失败，所以必须探测而不是假定。
const __hwUpsertCache = new WeakMap()
async function homeworkSummaryCanUpsert(env) {
  if (env.DB && __hwUpsertCache.has(env.DB)) return __hwUpsertCache.get(env.DB)
  let ok = false
  try {
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'homework'`
    ).all()
    ok = (results || []).some(r => /student_id/i.test(String(r.sql || '')) && /UNIQUE/i.test(String(r.sql || '')))
  } catch { ok = false }
  if (env.DB) __hwUpsertCache.set(env.DB, ok)
  return ok
}

// 教师班级范围判定：只有「双方都明确有班级且不一致」才阻断。
// 教师未设班级 / 「全部班级」→ 不限；学生未分班 → 没有可比较的对象，不阻断
// （否则一个还没分班的学生会让教师完全没法为他录入作业）。
function teacherOutOfScope(user, studentClassName) {
  if (!user || user.role === 'admin') return false
  const mine = String(user.className || '').trim()
  const theirs = String(studentClassName || '').trim()
  if (!mine || mine === '全部班级') return false
  if (!theirs || theirs === '全部班级') return false
  return normalizeClassName(mine) !== normalizeClassName(theirs)
}

// 由明细回写汇总。allowZero=false 时，没有任何已标记记录的学生保留原有手工汇总值，
// 避免明细功能一上线就把教师手工录入的提交率清零。
async function recomputeHomeworkForStudents(env, studentIds, { allowZero = false } = {}) {
  const ids = [...new Set((studentIds || []).filter(Boolean))]
  if (!ids.length) return 0

  await ensureHomeworkSchema(env)
  const shape = await homeworkSummaryShape(env)
  const canUpsert = await homeworkSummaryCanUpsert(env)

  let updated = 0

  for (const chunk of chunksOf(ids)) {
    // ① 一条 SQL 取回整批学生的状态计数（原本每人一条 SELECT）
    const { results } = await env.DB.prepare(
      `SELECT student_id, status, COUNT(*) AS c
       FROM homework_records
       WHERE student_id IN (${placeholders(chunk.length)})
       GROUP BY student_id, status`
    ).bind(...chunk).all()

    const agg = new Map()
    for (const r of (results || [])) {
      if (!agg.has(r.student_id)) agg.set(r.student_id, { total: 0, missed: 0 })
      const a = agg.get(r.student_id)
      const c = Number(r.c) || 0
      if (r.status === 'submitted' || r.status === 'late') a.total += c
      else if (r.status === 'missing') { a.total += c; a.missed += c }
    }

    const targets = []
    for (const sid of chunk) {
      const a = agg.get(sid)
      if (!a) {
        // 该学生一条明细都没有：allowZero 时才把汇总归零，否则保留原有手工值
        if (allowZero) targets.push([sid, 0, 0])
        continue
      }
      if (a.total === 0 && !allowZero) continue
      targets.push([sid, a.total, a.missed])
    }
    if (!targets.length) continue

    if (canUpsert) {
      // ② 有 student_id 唯一索引：整批写成一次 batch（一次往返），
      //    每人的 2~3 次往返 → 总共 2 次往返。48 人从 ~96 次降到 2 次。
      const cols = ['student_id', 'total', 'missed']
      if (shape.hasRateColumn) cols.push('rate')
      if (shape.hasUpdatedAt) cols.push('updated_at')
      const marks = cols.map(c => (c === 'updated_at' ? `datetime('now')` : '?'))
      const sets = ['total = excluded.total', 'missed = excluded.missed']
      if (shape.hasRateColumn) sets.push('rate = excluded.rate')
      if (shape.hasUpdatedAt) sets.push('updated_at = excluded.updated_at')

      const stmts = targets.map(([sid, total, missed]) => {
        const vals = [sid, total, missed]
        if (shape.hasRateColumn) vals.push(total === 0 ? 0 : (total - missed) / total)
        return env.DB.prepare(
          `INSERT INTO homework (${cols.join(', ')}) VALUES (${marks.join(', ')})
           ON CONFLICT(student_id) DO UPDATE SET ${sets.join(', ')}`
        ).bind(...vals)
      })
      await env.DB.batch(stmts)
      updated += targets.length
    } else {
      // ③ 没有唯一索引（存量重复行导致建索引失败）：
      //    退回逐条走唯一写入入口，绝不在这里自己拼 INSERT，免得绕开生成列判定。
      for (const [sid, total, missed] of targets) {
        await writeHomeworkSummary(env, sid, total, missed)
        updated++
      }
    }
  }

  return updated
}

async function getOrCreateAssignment(env, className, subject, title, dueDate, createdBy) {
  const found = await env.DB.prepare(
    `SELECT id FROM homework_assignments WHERE class_name = ? AND subject = ? AND title = ? AND due_date = ?`
  ).bind(className, subject, title, dueDate).first()
  if (found) return { id: found.id, created: false }

  const res = await env.DB.prepare(
    `INSERT INTO homework_assignments (class_name, subject, title, due_date, created_by) VALUES (?, ?, ?, ?, ?)`
  ).bind(className, subject, title, dueDate, createdBy || null).run()
  return { id: res.meta?.last_row_id, created: true }
}

function homeworkCountsToStats(counts) {
  const c = { submitted: 0, late: 0, missing: 0, exempt: 0, pending: 0, ...counts }
  const submittedTotal = c.submitted + c.late
  const total = submittedTotal + c.missing
  return {
    submitted: c.submitted,
    late: c.late,
    missing: c.missing,
    exempt: c.exempt,
    pending: c.pending,
    total,
    submittedTotal,
    rate: total === 0 ? 0 : submittedTotal / total
  }
}

// 作业列表（含「谁没交」名单）
async function handleListHomeworkAssignments(request, env, user) {
  await ensureHomeworkTables(env)
  const url = new URL(request.url)
  const className = resolveHomeworkScope(user, url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 30, 1), 200)

  const sql = `
    SELECT ha.id, ha.class_name, ha.subject, ha.title, ha.due_date, ha.note, ha.created_at,
           IFNULL(SUM(CASE WHEN hr.status = 'submitted' THEN 1 ELSE 0 END), 0) AS submitted,
           IFNULL(SUM(CASE WHEN hr.status = 'late' THEN 1 ELSE 0 END), 0) AS late,
           IFNULL(SUM(CASE WHEN hr.status = 'missing' THEN 1 ELSE 0 END), 0) AS missing,
           IFNULL(SUM(CASE WHEN hr.status = 'exempt' THEN 1 ELSE 0 END), 0) AS exempt,
           IFNULL(SUM(CASE WHEN hr.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
    FROM homework_assignments ha
    LEFT JOIN homework_records hr ON hr.assignment_id = ha.id
    ${className ? 'WHERE ha.class_name = ?' : ''}
    GROUP BY ha.id
    ORDER BY ha.due_date DESC, ha.id DESC
    LIMIT ?`
  const binds = className ? [className, limit] : [limit]
  const { results } = await env.DB.prepare(sql).bind(...binds).all()
  const rows = results || []

  // 一次查出所有「未交 / 补交」名单，避免逐条查询
  const byAssignment = {}
  const ids = rows.map(r => r.id)
  if (ids.length) {
    const { results: names } = await env.DB.prepare(
      `SELECT hr.assignment_id AS aid, u.id AS sid, u.name AS name, hr.status AS status
       FROM homework_records hr
       JOIN users u ON u.id = hr.student_id
       WHERE hr.assignment_id IN (${placeholders(ids.length)})
         AND hr.status IN ('missing', 'late')
       ORDER BY u.id`
    ).bind(...ids).all()
    for (const n of (names || [])) {
      if (!byAssignment[n.aid]) byAssignment[n.aid] = { missing: [], late: [] }
      byAssignment[n.aid][n.status].push({ id: n.sid, name: n.name })
    }
  }

  return jsonResp(rows.map(r => ({
    id: r.id,
    className: r.class_name,
    subject: r.subject,
    title: r.title,
    dueDate: r.due_date,
    note: r.note,
    createdAt: r.created_at,
    stats: homeworkCountsToStats({
      submitted: Number(r.submitted) || 0,
      late: Number(r.late) || 0,
      missing: Number(r.missing) || 0,
      exempt: Number(r.exempt) || 0,
      pending: Number(r.pending) || 0
    }),
    notSubmitted: (byAssignment[r.id] || {}).missing || [],
    lateStudents: (byAssignment[r.id] || {}).late || []
  })))
}

// 新建作业：自动为该班全体学生建立「待标记」记录
async function handleCreateHomeworkAssignment(request, env, teacher) {
  await ensureHomeworkTables(env)
  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }

  const className = normalizeClassName(body.className || teacher.className || '')
  const title = String(body.title || '').trim()
  const subject = String(body.subject || '').trim()
  const dueDate = normalizeDate(body.dueDate)
  const note = String(body.note || '').trim()

  if (!className) return jsonResp({ error: '请选择班级' }, 400)
  if (!title) return jsonResp({ error: '请填写作业标题' }, 400)
  if (!dueDate) return jsonResp({ error: '请填写截止日期（YYYY-MM-DD）' }, 400)

  const denied = assertHomeworkScope(teacher, className)
  if (denied) return denied

  const students = await dbGetClassStudents(env, className)
  if (!students.length) return jsonResp({ error: '该班级还没有学生，请先导入学生' }, 400)

  const { id: assignmentId } = await getOrCreateAssignment(env, className, subject, title, dueDate, teacher.id)

  // 一条 INSERT ... SELECT 给全班建「待标记」记录（原本逐个学生 INSERT，
  // 48 人的班 = 48 次往返，是同一类会撞上 Cloudflare 资源上限的写法）
  await env.DB.prepare(
    `INSERT OR IGNORE INTO homework_records (assignment_id, student_id, status)
     SELECT ?, id, 'pending' FROM users WHERE role = 'student' AND class_name = ?`
  ).bind(assignmentId, className).run()

  return jsonResp({ success: true, id: assignmentId, studentCount: students.length })
}

// 单次作业详情（以 users 表为驱动，新转入的学生也会出现在名单里）
async function handleGetHomeworkAssignment(request, env, user, id) {
  await ensureHomeworkTables(env)
  const asg = await env.DB.prepare(
    `SELECT id, class_name, subject, title, due_date, note, created_at FROM homework_assignments WHERE id = ?`
  ).bind(id).first()
  if (!asg) return jsonResp({ error: '作业不存在' }, 404)
  const denied = assertHomeworkScope(user, asg.class_name)
  if (denied) return denied

  const { results } = await env.DB.prepare(
    `SELECT u.id AS student_id, u.name AS name,
            IFNULL(hr.status, 'pending') AS status,
            IFNULL(hr.note, '') AS note
     FROM users u
     LEFT JOIN homework_records hr ON hr.student_id = u.id AND hr.assignment_id = ?
     WHERE u.role = 'student' AND u.class_name = ?
     ORDER BY u.id`
  ).bind(id, asg.class_name).all()

  const records = (results || []).map(r => ({
    studentId: r.student_id,
    name: r.name,
    status: r.status,
    note: r.note
  }))
  const counts = { submitted: 0, late: 0, missing: 0, exempt: 0, pending: 0 }
  for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1

  return jsonResp({
    assignment: {
      id: asg.id,
      className: asg.class_name,
      subject: asg.subject,
      title: asg.title,
      dueDate: asg.due_date,
      note: asg.note,
      createdAt: asg.created_at
    },
    records,
    stats: homeworkCountsToStats(counts)
  })
}

// 批量保存提交状态（点名）：只允许提交本班学生，保存后回写汇总
async function handleSaveHomeworkRecords(request, env, user, id) {
  await ensureHomeworkTables(env)
  const asg = await env.DB.prepare(
    `SELECT id, class_name FROM homework_assignments WHERE id = ?`
  ).bind(id).first()
  if (!asg) return jsonResp({ error: '作业不存在' }, 404)
  const denied = assertHomeworkScope(user, asg.class_name)
  if (denied) return denied

  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }
  const records = Array.isArray(body.records) ? body.records : null
  if (!records || !records.length) return jsonResp({ error: '没有需要保存的记录' }, 400)

  const validStudents = new Set((await dbGetClassStudents(env, asg.class_name)).map(s => s.id))
  const affected = []
  let updated = 0

  for (const r of records) {
    const studentId = String(r.studentId ?? r.student_id ?? '').trim()
    if (!studentId) return jsonResp({ error: '记录缺少学号' }, 400)
    if (!validStudents.has(studentId)) {
      return jsonResp({ error: `学号 ${studentId} 不在本班，已终止保存` }, 400)
    }
    const status = normalizeHomeworkStatus(r.status)
    if (!status || !HOMEWORK_STATUSES.includes(status)) {
      return jsonResp({ error: `学号 ${studentId} 的状态无效：${r.status}` }, 400)
    }
    const note = String(r.note || '').trim()

    await env.DB.prepare(
      `INSERT INTO homework_records (assignment_id, student_id, status, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(assignment_id, student_id)
       DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = datetime('now')`
    ).bind(id, studentId, status, note).run()
    affected.push(studentId)
    updated++
  }

  await recomputeHomeworkForStudents(env, affected, { allowZero: true })

  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c FROM homework_records WHERE assignment_id = ? GROUP BY status`
  ).bind(id).all()
  const counts = { submitted: 0, late: 0, missing: 0, exempt: 0, pending: 0 }
  for (const r of (results || [])) counts[r.status] = Number(r.c) || 0

  return jsonResp({ success: true, updated, stats: homeworkCountsToStats(counts) })
}

async function handleDeleteHomeworkAssignment(request, env, user, id) {
  await ensureHomeworkTables(env)
  const asg = await env.DB.prepare(
    `SELECT id, class_name FROM homework_assignments WHERE id = ?`
  ).bind(id).first()
  if (!asg) return jsonResp({ error: '作业不存在' }, 404)
  const denied = assertHomeworkScope(user, asg.class_name)
  if (denied) return denied

  const { results } = await env.DB.prepare(
    `SELECT student_id FROM homework_records WHERE assignment_id = ?`
  ).bind(id).all()
  const affected = (results || []).map(r => r.student_id)

  await env.DB.prepare(`DELETE FROM homework_records WHERE assignment_id = ?`).bind(id).run()
  await env.DB.prepare(`DELETE FROM homework_assignments WHERE id = ?`).bind(id).run()
  // 删掉最后一次作业后，明细口径应归零，因此允许写 0
  await recomputeHomeworkForStudents(env, affected, { allowZero: true })

  return jsonResp({ success: true, affectedStudents: affected.length })
}

// CSV 批量录入作业数据
// mode='summary'：学号,应交次数,未交次数 → 直接写 homework 汇总
// mode='detail' ：作业标题,科目,日期,学号,状态 → 建作业并逐人记状态
async function handleImportHomework(request, env, teacher) {
  await ensureHomeworkTables(env)
  let body
  try { body = await request.json() } catch { return jsonResp({ error: '请求体无效' }, 400) }

  const mode = body.mode === 'detail' ? 'detail' : 'summary'
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length) return jsonResp({ error: '没有可导入的数据' }, 400)

  let imported = 0, skipped = 0
  const errors = []
  const affected = []

  // 教师只能录入自己班级（管理员按学生实际班级）
  const ownClass = normalizeClassName(teacher.className || '')
  const scopeOk = className => teacher.role === 'admin' || normalizeClassName(className || '') === ownClass

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const studentId = String(row['学号'] || row['学生学号'] || row['id'] || '').trim()

    if (!studentId) {
      errors.push({ row: i + 1, reason: '缺少学号' })
      continue
    }
    const student = await env.DB.prepare(
      `SELECT id, name, class_name FROM users WHERE id = ? AND role = 'student'`
    ).bind(studentId).first()
    if (!student) {
      errors.push({ row: i + 1, studentId, reason: '学生不存在' })
      skipped++
      continue
    }
    if (!scopeOk(student.class_name)) {
      errors.push({ row: i + 1, studentId, reason: '学生不在你负责的班级' })
      skipped++
      continue
    }

    try {
      if (mode === 'summary') {
        const rawTotal = row['应交次数'] ?? row['应交'] ?? row['total'] ?? row['应提交次数']
        const rawMissed = row['未交次数'] ?? row['未交'] ?? row['missed'] ?? row['缺交次数']
        const total = Number(rawTotal)
        const missed = Number(rawMissed)
        if (!Number.isInteger(total) || total < 0) {
          errors.push({ row: i + 1, studentId, reason: '应交次数必须是不小于 0 的整数' })
          continue
        }
        if (!Number.isInteger(missed) || missed < 0 || missed > total) {
          errors.push({ row: i + 1, studentId, reason: '未交次数必须是不小于 0 且不超过应交次数的整数' })
          continue
        }
        await upsertHomeworkSummary(env, studentId, total, missed)
        imported++
      } else {
        const title = String(row['作业标题'] || row['标题'] || row['title'] || '').trim()
        const subject = String(row['科目'] || row['subject'] || '').trim()
        const dueDate = normalizeDate(row['日期'] || row['截止日期'] || row['due_date'] || row['dueDate']) || new Date().toISOString().slice(0, 10)
        const rawStatus = row['状态'] ?? row['提交状态'] ?? row['status'] ?? ''
        const status = normalizeHomeworkStatus(rawStatus)
        if (!title) {
          errors.push({ row: i + 1, studentId, reason: '缺少作业标题' })
          continue
        }
        if (!status) {
          errors.push({ row: i + 1, studentId, reason: `无法识别的状态：${rawStatus}` })
          continue
        }
        const { id: assignmentId } = await getOrCreateAssignment(env, student.class_name, subject, title, dueDate, teacher.id)
        await env.DB.prepare(
          `INSERT INTO homework_records (assignment_id, student_id, status, note)
           VALUES (?, ?, ?, '')
           ON CONFLICT(assignment_id, student_id)
           DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
        ).bind(assignmentId, studentId, status).run()
        affected.push(studentId)
        imported++
      }
    } catch (e) {
      errors.push({ row: i + 1, studentId, reason: '写入失败: ' + e.message })
    }
  }

  let summaryUpdated = 0
  if (mode === 'detail' && affected.length) {
    summaryUpdated = await recomputeHomeworkForStudents(env, affected)
  }

  return jsonResp({ success: true, mode, imported, skipped, summaryUpdated, errors, total: rows.length })
}

// ===== 主入口 =====
export async function onRequest(context) {
  const { request, env } = context
  const url = new URL(request.url)

  // 去掉 /api 前缀，取剩余路径
  let path = url.pathname
  if (path.startsWith('/api/')) {
    path = path.slice(4) // 去掉 '/api'
  } else if (path.startsWith('/api')) {
    path = path.slice(4)
  }

  const method = request.method

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    })
  }

  // 公开路由
  if (path === '/auth/login' && method === 'POST') return handleLogin(request, env)
  if (path === '/auth/register' && method === 'POST') return handleRegister(request, env)
  if (path === '/health' || path === '/') {
    return jsonResp({ status: 'ok', source: 'pages-functions', time: new Date().toISOString() })
  }
  // 科目库（公开元数据）
  if (path === '/subjects' && method === 'GET') {
    return handleListSubjects()
  }
  // KV 诊断
  if (path === '/debug/kv' && method === 'GET') {
    const kvTest = await env.SESSIONS?.put('__kv_test__', 'ok', { expirationTtl: 60 })
    const kvGet = await env.SESSIONS?.get('__kv_test__')
    return jsonResp({ env: typeof env, dbType: typeof env?.DB, sessionsType: typeof env?.SESSIONS, kvPut: kvTest, kvGet })
  }

  // 需要登录
  const { user, response } = await requireAuth(request, env)
  if (response) return response

  if (path === '/auth/logout' && method === 'POST') return handleLogout(request, env)
  if (path === '/auth/me' && method === 'GET') return handleMe(request, env)
  if (path === '/auth/change-password' && method === 'POST') return handleChangePassword(request, env, user)

  // 班级列表
  if (path === '/classrooms' && method === 'GET') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleListClassrooms(request, env, t)
  }

  // 学科成绩分析（班级概览的图表数据源；教师/管理员）
  if (path === '/stats/subject-analysis' && method === 'GET') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleGetSubjectAnalysis(request, env, t, url)
  }

  // 学生列表
  if (path === '/students' && method === 'GET') {
    // 信息隔离：学生端只能取到自己这一条。
    // 班级名单、同学的作业提交率属于教师/管理员的管理数据，学生不应可见
    // （原先学生登录后会拿到整个班级名单，等于把全班信息公开给学生）。
    if (user.role === 'student') {
      const me = await dbGetStudents(env, null, user.id)
      return jsonResp(me)
    }
    // 教师/管理员：query 参数优先，其次 session 班级；空/全部班级 → 查全部
    const rawClass = url.searchParams.get('class') || user.className
    const className = (!rawClass || rawClass === '全部班级') ? null : rawClass
    const students = await dbGetStudents(env, className)
    return jsonResp(students)
  }

  // 单条添加学生
  if (path === '/students' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleCreateStudent(request, env, t)
  }

  // 编辑学生
  if (path.match(/^\/students\/[^/]+$/) && method === 'PUT') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleUpdateStudent(request, env, t, path.split('/')[2])
  }
  // 删除学生
  if (path.match(/^\/students\/[^/]+$/) && method === 'DELETE') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleDeleteStudent(request, env, t, path.split('/')[2])
  }

  // 批量导入学生
  if (path === '/students/import' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleImportStudents(request, env, t)
  }

  // 批量删除学生（导入出错后的收拾工具：一次清掉一批，不必逐条点）
  if (path === '/students/bulk-delete' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleBulkDeleteStudents(request, env, t)
  }

  // 批量导入成绩
  if (path === '/students/import-scores' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleImportScores(request, env, t)
  }

  // 批量录入作业数据（CSV：汇总式 / 明细式）
  if (path === '/students/import-homework' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleImportHomework(request, env, t)
  }

  // 单个学生档案
  if (path.startsWith('/student/') && method === 'GET') {
    const parts = path.split('/').filter(Boolean)
    const studentId = parts[1]
    if (user.role === 'student' && user.id !== studentId) {
      return jsonResp({ error: '无权查看' }, 403)
    }
    if (parts[2] === 'scores') {
      const { results } = await env.DB.prepare(
        `SELECT exam_name, subject, score FROM scores WHERE student_id = ? ORDER BY id`
      ).bind(studentId).all()
      return jsonResp(results)
    }
    if (parts[2] === 'events') {
      await ensureEventImages(env)
      return jsonResp(await readEvents(env, studentId))
    }
    const student = await dbGetStudent(env, studentId)
    if (!student) return jsonResp({ error: '未找到该学生' }, 404)
    return jsonResp(student)
  }

  if (path.match(/^\/student\/[^/]+\/score$/) && method === 'POST') {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleAddScore(request, env, teacher, path.split('/')[2])
  }

  // 修改 / 删除单条成绩 —— 录入有误时的改正入口。
  // 定位用成绩行主键（前端从 /student/:id 的 _ids 里拿到），而不是 (考试,科目)：
  // 主键在「改科目」这种场景下依然指向同一条记录，(考试,科目) 会自相矛盾。
  if (path.match(/^\/student\/[^/]+\/score\/[^/]+$/) && (method === 'PUT' || method === 'DELETE')) {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    const parts = path.split('/').filter(Boolean) // ['student', 学号, 'score', 成绩行id]
    return method === 'PUT'
      ? handleUpdateScore(request, env, teacher, parts[1], parts[3])
      : handleDeleteScore(request, env, teacher, parts[1], parts[3])
  }

  if (path.match(/^\/student\/[^/]+\/event$/) && method === 'POST') {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleAddEvent(request, env, teacher, path.split('/')[2])
  }
  if (path.match(/^\/student\/[^/]+\/event$/) && method === 'DELETE') {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleDeleteEvent(request, env, teacher, path.split('/')[2])
  }

  // 课堂行为评分编辑（教师/管理员）
  if (path.match(/^\/student\/[^/]+\/behavior$/) && method === 'PUT') {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleUpdateBehavior(request, env, teacher, path.split('/')[2])
  }

  // 作业提交情况编辑（教师/管理员）
  if (path.match(/^\/student\/[^/]+\/homework$/) && method === 'PUT') {
    const { user: teacher, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleUpdateHomework(request, env, teacher, path.split('/')[2])
  }

  // ===== 作业明细：每次作业 × 每人提交状态 =====
  // 作业列表（含「谁没交」名单）
  if (path === '/homework/assignments' && method === 'GET') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleListHomeworkAssignments(request, env, t)
  }
  // 新建作业（自动为该班学生建立待标记记录）
  if (path === '/homework/assignments' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleCreateHomeworkAssignment(request, env, t)
  }
  // 单次作业详情（名单 + 状态）
  if (path.match(/^\/homework\/assignments\/[^/]+$/) && method === 'GET') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleGetHomeworkAssignment(request, env, t, path.split('/')[3])
  }
  // 保存点名结果
  if (path.match(/^\/homework\/assignments\/[^/]+\/records$/) && method === 'PUT') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleSaveHomeworkRecords(request, env, t, path.split('/')[3])
  }
  // 删除作业（连带明细，并重算汇总）
  if (path.match(/^\/homework\/assignments\/[^/]+$/) && method === 'DELETE') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleDeleteHomeworkAssignment(request, env, t, path.split('/')[3])
  }

  // 邀请码管理
  if (path === '/admin/invite-codes' && method === 'GET') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleListInviteCodes(request, env)
  }
  if (path === '/admin/invite-codes' && method === 'POST') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleCreateInviteCodes(request, env, a)
  }
  if (path.match(/^\/admin\/invite-codes\/[^/]+$/) && method === 'DELETE') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleRevokeInviteCode(request, env, path.split('/')[3])
  }

  // 家长账号管理
  if (path === '/admin/parents' && method === 'GET') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleListParents(request, env)
  }
  if (path === '/admin/parents' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleCreateParent(request, env, t)
  }
  // 编辑家长
  if (path.match(/^\/admin\/parents\/[^/]+$/) && method === 'PUT') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleUpdateParent(request, env, t, path.split('/')[3])
  }
  // 删除家长
  if (path.match(/^\/admin\/parents\/[^/]+$/) && method === 'DELETE') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleDeleteParent(request, env, t, path.split('/')[3])
  }
  if (path === '/admin/parent-links' && method === 'POST') {
    const { user: t, response: r } = await requireTeacher(request, env)
    if (r) return r
    return handleLinkParent(request, env, t)
  }

  // 教师管理
  if (path === '/admin/teachers' && method === 'GET') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleListTeachers(request, env)
  }
  if (path === '/admin/teachers' && method === 'POST') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleCreateTeacher(request, env, a)
  }
  // 编辑教师
  if (path.match(/^\/admin\/teachers\/[^/]+$/) && method === 'PUT') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleUpdateTeacher(request, env, a, path.split('/')[3])
  }
  // 删除教师
  if (path.match(/^\/admin\/teachers\/[^/]+$/) && method === 'DELETE') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleDeleteTeacher(request, env, a, path.split('/')[3])
  }

  // 修正全角 className
  if (path === '/admin/fix-classnames' && method === 'POST') {
    const { user: a, response: r } = await requireAdmin(request, env)
    if (r) return r
    return handleFixClassNames(request, env)
  }

  // AI 报告
  if (path === '/ai/report' && method === 'POST') {
    return handleAIReport(request, env, user)
  }

  // 家长端
  if (path === '/parent/children' && method === 'GET') {
    const { user: p, response: r } = await requireParent(request, env)
    if (r) return r
    return handleParentChildren(request, env, p)
  }
  if (path.match(/^\/parent\/student\/[^/]+$/) && method === 'GET') {
    const { user: p, response: r } = await requireParent(request, env)
    if (r) return r
    return handleParentStudent(request, env, p, path.split('/')[3])
  }

  return jsonResp({ error: 'Not Found', path }, 404)
}
