// 数据访问层：所有页面都通过这里取数。
// 当前接 CF Pages Functions（同源 /api/*）；后端逻辑已从 Worker 移植到 Pages Functions。

import { students } from '../data/mock.js'
import { getToken } from './auth.js'

// ===== 接 CF Pages Functions =====
const USE_WORKER = true  // ← 切换开关
// Pages Functions 同源部署，前端请求 /api/* 由后端 catch-all 路由处理
const API = '/api'

async function fetchJSON(url, options = {}) {
  const token = getToken()
  if (token) {
    options.headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` }
  }
  const r = await fetch(url, options)
  if (!r.ok) {
    let msg = '请求失败: ' + r.status
    try { const d = await r.json(); if (d.error) msg = d.error } catch {}
    throw new Error(msg)
  }
  return r.json()
}

// 返回全班概览列表
// params = { class? } —— 仅管理员有效；教师端后端强制用其本班，忽略该参数
export async function getStudents(params = {}) {
  if (USE_WORKER) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    return fetchJSON(`${API}/students${qs ? '?' + qs : ''}`)
  }
  return students.map(s => ({
    id: s.id, name: s.name, className: s.className,
    lastExam: s.scores[s.scores.length - 1], homeworkRate: s.homework.rate
  }))
}

// 返回单个学生完整档案
export async function getStudent(id) {
  if (USE_WORKER) return fetchJSON(`${API}/student/${id}`)
  return students.find(s => s.id === id) || null
}

// AI 生成成长画像
export async function generateAIReport(studentId) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/ai/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId })
    })
  }
  await new Promise(r => setTimeout(r, 800))
  const s = students.find(x => x.id === studentId)
  return s?.aiReport || null
}

// ===== 管理后台接口 =====

// 班级列表（教师看自己的班，管理员看全部）
export async function getClassrooms() {
  if (USE_WORKER) return fetchJSON(`${API}/classrooms`)
  return ['高三(2)班']
}

// 学科成绩分析（班级概览的图表数据源）
// params = { class? } —— 仅管理员的有效，教师端后端会强制用其本班，忽略该参数
// 返回：{ scope, thresholds, exams, subjects, recordCount }
// 聚合在服务端 SQL 内完成，前端只负责画图（不要在这里二次拉全量成绩）
export async function getSubjectAnalysis(params = {}) {
  if (USE_WORKER) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    return fetchJSON(`${API}/stats/subject-analysis${qs ? '?' + qs : ''}`)
  }
  return { scope: { class: null, label: '全部班级', studentCount: 0 }, thresholds: { pass: 60, good: 70, excellent: 85 }, exams: [], subjects: [], recordCount: 0 }
}

// 教师列表（仅管理员）
export async function getTeachers() {
  if (USE_WORKER) return fetchJSON(`${API}/admin/teachers`)
  return []
}

// 创建教师（仅管理员）
export async function createTeacher(payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/admin/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true, user: payload }
}

// 单条添加学生
export async function createStudent(payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true, user: payload }
}

// CSV 批量导入学生（前端解析后传数组）
export async function importStudents(rows) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ students: rows })
    })
  }
  return { success: true, created: rows.length, skipped: 0, errors: [] }
}

// 家长查看自己关联的孩子列表
export async function getParentChildren() {
  if (USE_WORKER) return fetchJSON(`${API}/parent/children`)
  return []
}

// 家长查看单个孩子档案（后端已剔除心理画像）
export async function getParentStudent(id) {
  if (USE_WORKER) return fetchJSON(`${API}/parent/student/${id}`)
  return null
}

// ===== 科目库（成绩单下拉，覆盖全科）=====
export async function getSubjects() {
  if (USE_WORKER) return fetchJSON(`${API}/subjects`)
  return ['语文', '数学', '英语', '音乐', '美术', '体育', '道法', '科学', '物理', '化学', '生物', '历史', '地理', '政治']
}

// 编辑学生（教师/管理员）
export async function updateStudent(id, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// 删除学生（教师/管理员，级联删除成绩/行为/事件等）
export async function deleteStudent(id) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/${id}`, { method: 'DELETE' })
  }
  return { success: true }
}

// 批量删除学生（教师/管理员）。
// 逐条删时「每删一个都要重拉一次学生列表」，名单一长就会把页面拖进
// Cloudflare 的资源上限（表现为 503、列表空白、什么都点不了）。
// 这里一次请求清一批，SQL 条数与学生数无关。
export async function bulkDeleteStudents(ids) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
  }
  return { success: true, removed: ids.length, removedStudents: [], skipped: [] }
}

// 教师添加单条成绩
// payload: { subject, exam_name, score, images? }（images 为压缩后的 dataURL 数组，最多 3 张）
// 返回 { success, replaced } —— replaced=true 表示同一场考试的同一科目已有记录，
// 这次是覆盖更新（行为等同于改正），页面据此给出不同措辞。
export async function addScore(studentId, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// 修改单条成绩（教师/管理员）—— 录入有误时的改正入口。
// scoreId 是成绩行主键，由 GET /student/:id 返回的 scores[]._ids[科目] 提供。
// payload 里没给的字段保持原值；images 只在真的改了附件时才传（传 [] 表示清空）。
export async function updateScore(studentId, scoreId, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/score/${scoreId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// 删除单条成绩（教师/管理员）—— 只删这一科，不动同场考试的其它科目
export async function deleteScore(studentId, scoreId) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/score/${scoreId}`, { method: 'DELETE' })
  }
  return { success: true }
}

// 批量导入成绩
// rows: [{ 学号, 考试名称, 科目, 分数 }]
export async function importScores(rows) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/import-scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores: rows })
    })
  }
  return { success: true, imported: rows.length, skipped: 0, errors: [] }
}

// payload: { event_date, event_type, content }
// payload: { event_date, event_type, content, images? }
// images 是 base64 dataURL 的数组（最多 3 张，前端已压缩），不传或传 [] 表示没有配图
export async function addEvent(studentId, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// payload: { id } —— 按事件行主键删。
// 旧的 { event_date, event_type, content } 三元组仍被后端接受，但会把同一天、
// 同类型、同内容的两条记录一起删掉，只作老数据回落（见 utils/eventForm.js）。
export async function deleteEvent(studentId, payload) {
  if (USE_WORKER) {
    const params = new URLSearchParams(payload).toString()
    return fetchJSON(`${API}/student/${studentId}/event?${params}`, {
      method: 'DELETE'
    })
  }
  return { success: true }
}

// 保存课堂行为评分（0-5）
export async function updateBehavior(studentId, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/behavior`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// 保存作业提交情况（total 应交次数 / missed 未交次数，rate 后端自动计算）
export async function updateHomework(studentId, payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/student/${studentId}/homework`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// ===== 作业明细模型（每次作业 × 每人提交状态）=====

// 作业列表（含「谁没交」名单）：params = { class?, limit? }
export async function getHomeworkAssignments(params = {}) {
  if (USE_WORKER) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    return fetchJSON(`${API}/homework/assignments${qs ? '?' + qs : ''}`)
  }
  return []
}

// 新建作业：payload = { className, subject, title, dueDate, note? }
export async function createHomeworkAssignment(payload) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/homework/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  return { success: true }
}

// 单次作业详情：{ assignment, records, stats }
export async function getHomeworkAssignment(id) {
  if (USE_WORKER) return fetchJSON(`${API}/homework/assignments/${id}`)
  return null
}

// 保存点名结果：records = [{ studentId, status, note? }]
export async function saveHomeworkRecords(id, records) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/homework/assignments/${id}/records`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records })
    })
  }
  return { success: true }
}

// 删除作业（连带明细并重算汇总）
export async function deleteHomeworkAssignment(id) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/homework/assignments/${id}`, { method: 'DELETE' })
  }
  return { success: true }
}

// 批量录入作业数据
// mode='summary'：rows = [{ 学号, 应交次数, 未交次数 }]
// mode='detail' ：rows = [{ 作业标题, 科目, 日期, 学号, 状态 }]
export async function importHomework(mode, rows) {
  if (USE_WORKER) {
    return fetchJSON(`${API}/students/import-homework`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, rows })
    })
  }
  return { success: true, imported: rows.length, skipped: 0, errors: [] }
}
