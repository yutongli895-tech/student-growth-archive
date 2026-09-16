<template>
  <div>
    <!-- ================= 学生视角 =================
         设计意图：学生只能看到自己。班级名单、同学提交率、
         班级平均统计都属于教师的管理数据，不在这里出现。
         后端 /students 同样只返回本人，前端只是不做无谓的请求。 -->
    <template v-if="isStudent">
      <div class="card">
        <h2 style="margin:0">我的成长档案</h2>
        <div v-if="loadError" class="msg err">{{ loadError }}</div>
        <div v-else-if="!me" class="empty-state">
          <div class="empty-icon">🎒</div>
          <p>暂时读不到你的档案信息</p>
          <p class="sub">请联系老师确认你的账号是否已关联学生档案</p>
        </div>
        <div v-else class="me-row">
          <div class="avatar" style="width:52px;height:52px;font-size:20px">{{ me.name.charAt(0) }}</div>
          <div class="meta">
            <div class="name">{{ me.name }}</div>
            <div class="sub">{{ me.className }} · 学号 {{ me.id }}</div>
          </div>
          <span class="spacer"></span>
          <button class="btn primary" @click="$router.push('/student/' + me.id)">查看完整档案 →</button>
        </div>
      </div>

      <div v-if="me" class="grid cols-2">
        <div class="card stat-card">
          <div class="stat-label">我的作业提交率</div>
          <div class="stat-num" :style="{ color: (me.homeworkRate || 0) < 0.9 ? 'var(--warn)' : 'var(--primary)' }">
            {{ Math.round((me.homeworkRate || 0) * 100) }}<span class="stat-unit">%</span>
          </div>
          <div class="sub">{{ (me.homeworkRate || 0) < 0.9 ? '继续保持，按时提交作业' : '很稳定，继续保持' }}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">最近一次考试</div>
          <template v-if="myLastExam.subjects.length">
            <div class="stat-text">{{ myLastExam.exam }}</div>
            <div class="score-chips">
              <span v-for="s in myLastExam.subjects" :key="s.subject" class="chip">
                {{ s.subject }} <strong>{{ s.score }}</strong>
              </span>
            </div>
          </template>
          <div v-else class="sub" style="margin-top:10px">还没有成绩记录</div>
        </div>
      </div>
    </template>

    <!-- ================= 教师 / 管理员视角 =================
         信息层级：班级摘要 → 学科成绩分析 → 学生名单。
         「概览」的主体是班级整体，学生名单属于下钻明细，因此排在分析之后。 -->
    <template v-else>
      <div class="card">
        <div class="row between">
          <h2 style="margin:0">班级概览 · {{ scopeLabel }}</h2>
          <div class="row">
            <!-- 班级选择只给管理员：教师由后端强制限定本班，前端不给越权的入口 -->
            <select v-if="isAdmin" v-model="classFilter" class="select select-sm" aria-label="选择班级">
              <option value="">全部班级</option>
              <option v-for="c in classrooms" :key="c" :value="c">{{ c }}</option>
            </select>
            <button v-if="isStaff" class="btn outline" @click="$router.push('/homework')">
              📋 作业管理
            </button>
          </div>
        </div>

        <div class="grid cols-3" style="margin-top:16px">
          <div class="card stat-card">
            <div class="stat-num" style="color:var(--primary)">{{ list.length }}</div>
            <div class="sub">在校学生</div>
          </div>
          <div class="card stat-card">
            <div class="stat-num" :style="{ color: avgRate !== null && avgRate < 90 ? 'var(--warn)' : 'var(--primary)' }">
              {{ avgRate === null ? '—' : avgRate + '%' }}
            </div>
            <div class="sub">平均作业提交率</div>
          </div>
          <div class="card stat-card" :class="{ clickable: needAttention && isStaff }"
               :title="needAttention && isStaff ? '去作业管理查看谁没交' : ''"
               @click="needAttention && isStaff && $router.push('/homework')">
            <div class="stat-num" :style="{ color: needAttention ? 'var(--danger)' : 'var(--primary)' }">
              {{ needAttention }}
            </div>
            <div class="sub">需关注学生<template v-if="needAttention && isStaff">（点击查看）</template></div>
          </div>
        </div>
      </div>

      <!-- ================= 各学科成绩分析 ================= -->
      <div class="card">
        <h2>各学科成绩分析</h2>
        <ClassScoreAnalysis :data="analysis" :loading="analysisLoading" :error="analysisError" />
      </div>

      <div class="card">
        <h2>学生列表</h2>
        <div v-if="loadError" class="msg err">{{ loadError }}</div>
        <div v-else-if="!list.length" class="empty-state">
          <div class="empty-icon">🎒</div>
          <p>还没有学生数据</p>
          <p class="sub">可在「管理 → 学生管理」中单条添加或批量导入学生</p>
        </div>
        <div v-else class="grid">
          <div
            v-for="s in list"
            :key="s.id"
            class="student-card"
            @click="$router.push('/student/' + s.id)"
          >
            <div class="avatar">{{ s.name.charAt(0) }}</div>
            <div class="meta">
              <div class="name">{{ s.name }}</div>
              <div class="sub">{{ s.className }}</div>
            </div>
            <span class="badge" :class="{ warn: s.homeworkRate < 0.9 }">
              作业 {{ Math.round(s.homeworkRate * 100) }}%
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { getStudents, getClassrooms, getSubjectAnalysis } from '../api/student.js'
import { getRole } from '../api/auth.js'
import ClassScoreAnalysis from '../components/ClassScoreAnalysis.vue'

const role = getRole()
const isAdmin = role === 'admin'
const isStaff = role === 'teacher' || isAdmin
const isStudent = role === 'student'

const list = ref([])
const loadError = ref('')

// 班级范围：管理员可选，教师端后端强制用本班（前端不给越权入口）
const classrooms = ref([])
const classFilter = ref('')

// 学科成绩分析（聚合在服务端完成，这里只存结果）
const analysis = ref(null)
const analysisLoading = ref(false)
const analysisError = ref('')

// 学生视角：后端只返回本人，这里取第一条即为「我」
const me = computed(() => (isStudent ? list.value[0] || null : null))

// 标题里的班级范围。
// 首选后端返回的 scope.label —— 它由服务端按同一个范围判定产生，是权威来源：
// 教师未设班级时后端会如实回「全部班级」，而数据也确实是不筛选的，
// 这样标题与图里的数据永远说的是同一件事（以前拿名单里第一个学生的班级当标题，
// 教师未分班时会显示成某个学生的班级，与实际口径不符）。
const scopeLabel = computed(() => {
  if (isAdmin) return classFilter.value || '全部班级'
  return analysis.value?.scope?.label || classrooms.value[0] || list.value[0]?.className || '—'
})

// 把最近一次考试的科目分数摊平，便于逐科展示
const myLastExam = computed(() => {
  const last = me.value?.lastExam || {}
  const { exam, _images, ...scores } = last
  const subjects = Object.keys(scores)
    .filter(k => k !== 'exam' && !k.startsWith('_'))
    .map(k => ({ subject: k, score: scores[k] }))
    .filter(s => s.score !== null && s.score !== undefined && s.score !== '')
  return { exam: exam || '', subjects }
})

// 无学生时返回 null（而不是 NaN%），模板显示「—」
const avgRate = computed(() => {
  if (!list.value.length) return null
  const sum = list.value.reduce((a, s) => a + (Number(s.homeworkRate) || 0), 0)
  return Math.round((sum / list.value.length) * 100)
})

const needAttention = computed(() => list.value.filter(s => (Number(s.homeworkRate) || 0) < 0.9).length)

async function loadStudents() {
  loadError.value = ''
  try {
    list.value = (await getStudents({ class: classFilter.value })) || []
  } catch (e) {
    loadError.value = e.message
    list.value = []
  }
}

async function loadAnalysis() {
  analysisLoading.value = true
  analysisError.value = ''
  try {
    analysis.value = await getSubjectAnalysis({ class: classFilter.value })
  } catch (e) {
    analysisError.value = e.message
    analysis.value = null
  } finally {
    analysisLoading.value = false
  }
}

// 切班级时两份数据一起重拉，避免列表与分析显示两个不同的班
watch(classFilter, () => {
  if (!isStaff) return
  loadStudents()
  loadAnalysis()
})

onMounted(async () => {
  if (isStaff) {
    // 班级列表拿不到不影响主流程（教师端本来也没有选择器）
    try { classrooms.value = await getClassrooms() } catch { classrooms.value = [] }
    await Promise.all([loadStudents(), loadAnalysis()])
    return
  }
  await loadStudents()
})
</script>

<style scoped>
.stat-card { margin: 0; text-align: center; padding: 18px; }
.stat-num { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat-unit { font-size: 16px; font-weight: 600; margin-left: 1px; }
.stat-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.stat-text { font-size: 17px; font-weight: 600; }
.stat-card.clickable { cursor: pointer; }
.stat-card.clickable:hover { border-color: rgba(47, 125, 110, .3); box-shadow: var(--shadow-md); }
.empty-state { text-align: center; padding: 36px 16px; color: var(--muted); }
.empty-icon { font-size: 34px; opacity: .5; margin-bottom: 8px; }
.empty-state p { font-size: 14px; }
.empty-state .sub { font-size: 12px; }
.msg { padding: 10px 16px; border-radius: var(--radius-sm); font-size: 14px; }
.msg.err { background: var(--danger-light); color: var(--danger); }

/* 班级选择器：与作业管理页保持同一尺寸，避免同一控件在两页长得不一样 */
.select-sm { padding: 6px 10px; font-size: 13px; }

/* 学生视角的本人信息行 */
.me-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 16px; }

/* 最近考试的分科分数胶囊 */
.score-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px; }
.chip {
  display: inline-flex; align-items: baseline; gap: 4px;
  background: var(--bg); border: 1px solid var(--line);
  border-radius: 99px; padding: 3px 10px;
  font-size: 12px; color: var(--muted);
}
.chip strong { color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
</style>
