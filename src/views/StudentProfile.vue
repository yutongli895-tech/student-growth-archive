<template>
  <div v-if="loading">加载中…</div>
  <div v-else-if="!student" class="card">未找到该学生档案。</div>
  <div v-else>
    <div class="page-head no-print">
      <a class="back" href="#/app" @click.prevent="$router.push('/app')">← 返回班级概览</a>
      <span class="spacer"></span>
      <button class="btn outline" @click="exportPDF">📄 导出PDF</button>
    </div>

    <!-- 编辑态提示条：与顶栏那个全局开关是同一个状态，这里再明示一次并提供「就地退出」，
         免得用户在长页面里往下翻之后忘了自己正处于可编辑态。 -->
    <div v-if="canEdit" class="edit-banner no-print">
      <span class="edit-banner-icon">✏️</span>
      <div>
        <strong>编辑模式已开启</strong>
        <div class="sub">可直接修改下方的课堂行为评分、作业提交情况、成绩与时间线记录。</div>
      </div>
      <span class="spacer"></span>
      <button class="btn sm" @click="toggleEditMode">完成编辑</button>
    </div>

    <!-- 只读态提示：编辑入口是被「全局编辑模式」统一收起的，这里必须给出明确出口。
         上一版把编辑按钮藏在开关后面却没告诉教师开关在哪，导致「以为系统不给编辑」，
         所以只读态不允许静默 —— 一定要说清为什么看不到入口、以及怎么打开。 -->
    <div v-else-if="isStaff" class="readonly-hint no-print">
      <span class="rh-icon">🔒</span>
      <span><span class="rh-strong">当前为只读模式</span>，成绩录入、行为评分、时间线编辑等入口已隐藏。</span>
      <button class="btn sm outline" @click="toggleEditMode">开启编辑模式</button>
    </div>

    <!-- 学生头部 -->
    <div class="card">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div class="avatar" style="width:56px;height:56px;font-size:22px">{{ student.name.charAt(0) }}</div>
        <div>
          <h2 style="margin:0">{{ student.name }}</h2>
          <div class="sub" style="color:var(--muted)">{{ student.className }} · 学号 {{ student.id }}</div>
        </div>
        <span class="spacer" style="flex:1"></span>
        <div class="hw-pill">
          <span class="badge" :class="{ warn: student.homework.rate < 0.9 }">
            作业提交 {{ Math.round(student.homework.rate * 100) }}%
          </span>
          <span v-if="student.homework.total" class="hw-detail">
            已交 {{ student.homework.total - student.homework.missed }}/{{ student.homework.total }}
          </span>
          <button v-if="canEdit" class="btn outline sm" @click="openHomeworkEdit">✏️ 编辑提交情况</button>
        </div>
      </div>
    </div>

    <!-- 图表区 -->
    <div class="grid cols-2">
      <div class="card">
        <h2>成绩趋势 <span class="h2-hint">（点击考试查看附件）</span></h2>
        <ScoreTrendChart :scores="student.scores" @exam-click="openExamDetail" />
      </div>
      <div class="card">
        <h2 class="card-head">
          课堂行为雷达
          <button v-if="canEdit" class="btn outline sm" @click="openBehaviorEdit">✏️ 编辑评分</button>
        </h2>
        <BehaviorRadar :behavior="student.behavior" />
      </div>
    </div>

    <!-- 作业明细：来自「作业管理」的逐次记录，用于回答「哪几次没交」 -->
    <div v-if="student.homeworkDetail && student.homeworkDetail.length" class="card">
      <h2 class="card-head">
        作业明细
        <span class="h2-hint">最近 {{ student.homeworkDetail.length }} 次 · 可在「作业管理」中标记</span>
      </h2>
      <div class="hw-detail-list">
        <div v-for="h in student.homeworkDetail" :key="h.id" class="hw-detail-row">
          <span class="hw-detail-date">{{ h.dueDate }}</span>
          <span class="hw-detail-title">{{ h.title }}</span>
          <span v-if="h.subject" class="badge">{{ h.subject }}</span>
          <span class="spacer"></span>
          <span class="badge" :class="statusTone(h.status)">{{ statusLabel(h.status) }}</span>
        </div>
      </div>
    </div>

    <!-- 添加成绩（教师/管理员，需先开启编辑模式） -->
    <div v-if="canEdit" class="card no-print">
      <h2>添加成绩</h2>
      <div class="score-form">
        <select v-model="scoreForm.subject" class="select">
          <option value="">选择科目</option>
          <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
        </select>
        <input v-model="scoreForm.exam_name" class="input" placeholder="考试名称，如 期中" />
        <input v-model="scoreForm.score" class="input" type="number" placeholder="分数" />
        <button class="btn primary" :disabled="scoreLoading" @click="doAddScore">{{ scoreLoading ? '提交中…' : '添加' }}</button>
      </div>
      <!-- 图片附件 -->
      <div class="img-attach">
        <label class="img-label">
          <input type="file" accept="image/*" capture="environment" multiple style="display:none" @change="onImgChange" />
          <span class="btn outline btn-sm">📷 附加图片（最多3张）</span>
        </label>
        <div v-if="scoreForm.images.length" class="img-preview-list">
          <div v-for="(img, i) in scoreForm.images" :key="i" class="img-thumb">
            <img :src="img.src" alt="附件" />
            <button class="img-remove" @click="removeImg(i)">✕</button>
          </div>
          <span style="font-size:12px;color:var(--muted)">{{ scoreForm.images.length }}/3</span>
        </div>
      </div>
      <p v-if="scoreMsg" :class="['msg', scoreMsgType]">{{ scoreMsg }}</p>
    </div>

    <!-- 成绩记录：录入有误的改正入口（同在编辑模式管辖下）
         放在「添加成绩」正下方 —— 录入和改正本来就是一回事，
         分成两个相距很远的地方，教师会在页面上来回找。 -->
    <ScoreRecordList
      v-if="canEdit"
      ref="scoreListRef"
      :scores="student.scores"
      :student-id="student.id"
      :subjects="subjects"
      @changed="reloadStudent"
    />

    <!-- 成绩详情弹窗（点击图表触发） -->
    <div v-if="showExamModal" class="modal-overlay" @click.self="showExamModal=false">
      <div class="modal exam-modal">
        <div class="modal-head">
          <h3>{{ examDetail.exam }}</h3>
          <button class="modal-close" @click="showExamModal=false">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="Object.keys(examDetail.scores).length" class="score-row-list">
            <div v-for="(v, subj) in examDetail.scores" :key="subj" class="score-row">
              <span>{{ subj }}</span>
              <span class="score-row-val">{{ v }}</span>
              <button
                v-if="canEdit"
                class="score-row-edit"
                :title="`修改 ${examDetail.exam} · ${subj} 的成绩`"
                @click="editFromExamModal(subj)"
              >✏️</button>
            </div>
          </div>
          <div v-if="examDetail.images && examDetail.imagesCount > 0" class="exam-images">
            <p style="font-size:13px;color:var(--muted);margin-bottom:8px">📎 附件图片：</p>
            <div class="exam-img-grid">
              <img v-for="(img, i) in examDetail.images" :key="i" :src="img" class="exam-img" @click="previewImg(img)" />
            </div>
          </div>
          <p v-else style="color:var(--muted);font-size:13px;text-align:center;padding:16px">暂无附件图片</p>
        </div>
      </div>
    </div>

    <!-- 图片预览 -->
    <div v-if="previewSrc" class="modal-overlay" @click="previewSrc=null">
      <img :src="previewSrc" class="preview-img" />
    </div>

    <!-- 行为评分编辑弹窗 -->
    <div v-if="behaviorEditing && canEdit" class="modal-overlay" @click.self="behaviorEditing=false">
      <div class="modal">
        <div class="modal-head">
          <h3>编辑课堂行为评分</h3>
          <button class="modal-close" @click="behaviorEditing=false">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--muted);margin-bottom:12px">每个维度满分 5 分，拖动滑块调整</p>
          <div v-for="(label, key) in behaviorFields" :key="key" class="behavior-field">
            <label>{{ label }}</label>
            <input v-model.number="behaviorForm[key]" type="range" min="0" max="5" step="0.5" class="slider" />
            <span class="slider-val">{{ Number(behaviorForm[key]).toFixed(1) }}</span>
          </div>
          <p v-if="behaviorMsg" :class="['msg', behaviorMsgType]" style="margin-top:12px">{{ behaviorMsg }}</p>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn" @click="behaviorEditing=false">取消</button>
            <button class="btn primary" :disabled="behaviorLoading" @click="doSaveBehavior">{{ behaviorLoading ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 作业提交情况编辑弹窗 -->
    <div v-if="homeworkEditing && canEdit" class="modal-overlay" @click.self="homeworkEditing=false">
      <div class="modal">
        <div class="modal-head">
          <h3>编辑作业提交情况</h3>
          <button class="modal-close" @click="homeworkEditing=false">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--muted);margin-bottom:12px">
            填写应交与未交次数，提交率将自动计算
          </p>
          <div class="hw-field">
            <label>应交作业次数</label>
            <input v-model.number="homeworkForm.total" type="number" min="0" class="input" />
          </div>
          <div class="hw-field">
            <label>未交作业次数</label>
            <input v-model.number="homeworkForm.missed" type="number" min="0" class="input" />
          </div>
          <div class="hw-preview">
            提交率预览：<strong>{{ homeworkPreview }}%</strong>
            <span class="hw-bar"><i :style="{ width: homeworkPreview + '%' }"></i></span>
          </div>
          <p v-if="homeworkMsg" :class="['msg', homeworkMsgType]" style="margin-top:12px">{{ homeworkMsg }}</p>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn" @click="homeworkEditing=false">取消</button>
            <button class="btn primary" :disabled="homeworkLoading" @click="doSaveHomework">{{ homeworkLoading ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- AI 报告 -->
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">AI 成长画像与建议</h2>
        <span v-if="aiSource" class="badge" :class="{ warn: aiSource === 'fallback' }">
          {{ aiSource === 'ai' ? '✨ AI 实时生成' : '⚡ 预置报告' }}
        </span>
        <span class="spacer" style="flex:1"></span>
        <button
          class="btn primary"
          :disabled="aiLoading"
          @click="regenerateAI"
        >{{ aiLoading ? '生成中…' : '🔄 重新生成' }}</button>
      </div>

      <div v-if="aiLoading" class="ai-loading">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <p>AI 正在分析学生数据并生成个性化报告…</p>
      </div>

      <div v-else>
        <p v-if="aiReport && aiReport.profile">{{ aiReport.profile }}</p>
        <p v-else style="color:var(--muted)">尚未生成 AI 报告，可点击右上角「重新生成」。</p>
        <div v-if="aiReport.weaknesses && aiReport.weaknesses.length" style="margin-top:12px">
          <strong class="weakness">薄弱点：</strong>
          <ul>
            <li v-for="(w, i) in aiReport.weaknesses" :key="i" class="weakness">
              {{ w.subject }} — {{ w.reason }}
            </li>
          </ul>
        </div>
        <div v-if="aiReport.suggestions && aiReport.suggestions.length" style="margin-top:12px">
          <strong>个性化建议：</strong>
          <div v-for="(s, i) in aiReport.suggestions" :key="i" class="suggestion">{{ s }}</div>
        </div>
        <div v-if="aiReport.talkScript" class="suggestion" style="border-color:var(--accent);background:var(--accent-light)">
          <strong>家校沟通话术：</strong>{{ aiReport.talkScript }}
        </div>
        <p v-if="aiError" style="color:var(--warn);font-size:12px;margin-top:8px">
          ⚠ {{ aiError }}
        </p>
        <p style="color:var(--muted);font-size:12px;margin-top:10px">* 以上内容由 AI 生成，仅供参考，以教师判断为准。</p>
      </div>
    </div>

    <!-- 时间线 -->
    <div class="card">
      <h2>成长时间线</h2>
      <!-- 教师添加事件 -->
      <div v-if="canEdit" class="event-form">
        <input v-model="eventForm.event_date" type="date" class="input" />
        <select v-model="eventForm.event_type" class="select">
          <option>奖励</option>
          <option>惩罚</option>
          <option>比赛</option>
          <option>活动</option>
          <option>提醒</option>
          <option>其他</option>
        </select>
        <input v-model="eventForm.content" type="text" class="input" placeholder="记录内容" style="flex:1; min-width:160px" />
        <button class="btn-primary btn-sm" :disabled="eventLoading" @click="doAddEvent">添加</button>
      </div>
      <div v-if="eventMsg" class="msg" :class="eventMsgType">{{ eventMsg }}</div>
      <div class="timeline">
        <div v-for="(e, i) in student.events" :key="i" class="timeline-item">
          <div class="date">{{ e.date }} · <span class="badge" :class="{ warn: e.type==='提醒' }">{{ e.type }}</span>
            <button v-if="canEdit" class="del-btn" @click="doDeleteEvent(i)" title="删除">×</button>
          </div>
          <div>{{ e.content }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getStudent, generateAIReport, getSubjects, addScore, addEvent, deleteEvent, updateBehavior, updateHomework } from '../api/student.js'
import { getRole } from '../api/auth.js'
import { useEditMode, setEditMode } from '../utils/editMode.js'
import { collectImages, MAX_IMAGES } from '../utils/imageCompress.js'
import ScoreTrendChart from '../components/ScoreTrendChart.vue'
import BehaviorRadar from '../components/BehaviorRadar.vue'
import ScoreRecordList from '../components/ScoreRecordList.vue'

const route = useRoute()
const student = ref(null)
const loading = ref(true)
const aiReport = ref({})
const aiLoading = ref(false)
const aiSource = ref('')
const aiError = ref('')
const subjects = ref([])
const isStaff = getRole() === 'teacher' || getRole() === 'admin'

// 成绩记录组件（修改/删除成绩的入口在那个组件里，这里只负责重新拉档案）
const scoreListRef = ref(null)

// 编辑权限来自全局开关（顶栏那个），本页不再自己维护第二份状态。
// canEdit = 教职工 且 编辑模式已开启；学生/家长在这个 computed 里就被挡住了。
const { editMode, canEdit, toggleEditMode } = useEditMode()

// 关闭编辑模式时，若还有编辑弹窗开着，一并收起。
// 否则会出现「开关已关，弹窗里的保存按钮仍可提交」的旁路。
// 成绩记录的弹窗不用在这里关 —— 那张卡片整个由 v-if="canEdit" 控制，
// 开关一关卡片连同弹窗一起卸载，不存在残留的旁路。
watch(editMode, on => {
  if (!on) {
    behaviorEditing.value = false
    homeworkEditing.value = false
  }
})

// 作业明细状态展示
const HW_STATUS_LABELS = { submitted: '已交', late: '补交', missing: '未交', exempt: '免交', pending: '待标记' }
const HW_STATUS_TONES = { late: 'warn', missing: 'danger' }
function statusLabel(s) { return HW_STATUS_LABELS[s] || s || '待标记' }
function statusTone(s) { return HW_STATUS_TONES[s] || '' }

const scoreForm = ref({ subject: '', exam_name: '', score: '', images: [] })
const scoreLoading = ref(false)
const scoreMsg = ref('')
const scoreMsgType = ref('ok')
const showExamModal = ref(false)
const examDetail = ref({ exam: '', scores: {}, images: {}, imagesCount: 0 })
const previewSrc = ref('')
const eventForm = ref({ event_date: '', event_type: '奖励', content: '' })
const eventMsg = ref('')
const eventMsgType = ref('ok')
const eventLoading = ref(false)
const behaviorEditing = ref(false)
const behaviorForm = ref({ raise_hand: 0, focus: 0, cooperation: 0, homework_quality: 0 })
const behaviorMsg = ref('')
const behaviorMsgType = ref('ok')
const behaviorLoading = ref(false)
const homeworkEditing = ref(false)
const homeworkForm = ref({ total: 0, missed: 0 })
const homeworkMsg = ref('')
const homeworkMsgType = ref('ok')
const homeworkLoading = ref(false)

// 作业提交率实时预览
const homeworkPreview = computed(() => {
  const t = Number(homeworkForm.value.total) || 0
  const m = Number(homeworkForm.value.missed) || 0
  if (t <= 0) return 0
  return Math.round(((t - Math.min(m, t)) / t) * 100)
})

const behaviorFields = {
  raise_hand: '举手积极性',
  focus: '专注度',
  cooperation: '合作度',
  homework_quality: '作业质量'
}

// ========== 成绩附件 ==========
// 压缩与「最多 3 张 / 1MB 上限」的规则统一放在 utils/imageCompress.js：
// 添加成绩和修改成绩都要挂附件，规则写两份迟早会不一致。
async function onImgChange(e) {
  const room = MAX_IMAGES - scoreForm.value.images.length
  const { added, errors } = await collectImages(e.target.files, room)
  if (added.length) scoreForm.value.images.push(...added)
  if (errors.length) { scoreMsg.value = errors.join('；'); scoreMsgType.value = 'err' }
  else if (added.length) { scoreMsg.value = `已附加 ${added.length} 张`; scoreMsgType.value = 'ok' }
  e.target.value = ''
}

function removeImg(i) {
  scoreForm.value.images.splice(i, 1)
}

function previewImg(src) {
  previewSrc.value = src
}

// ========== 成绩详情弹窗 ==========
function openExamDetail({ exam }) {
  const found = student.value.scores.find(s => s.exam === exam)
  if (!found) return
  const scores = {}
  const imgs = {}
  for (const [k, v] of Object.entries(found)) {
    // _ids / _images 是下划线开头的辅助字段，不是科目。
    // 判断题式地写死 '_images' 会漏掉后加的 _ids，把它当成一科画进弹窗。
    if (k === 'exam' || k.startsWith('_')) continue
    if (Array.isArray(v)) continue
    scores[k] = v
  }
  if (found._images) {
    for (const [subj, arr] of Object.entries(found._images)) {
      if (Array.isArray(arr) && arr.length) imgs[subj] = arr
    }
  }
  examDetail.value = {
    exam,
    scores,
    images: Object.values(imgs).flat(),
    imagesCount: Object.values(imgs).flat().length
  }
  showExamModal.value = true
}

// 「点击图表 → 看到某科分数 → 发现录错了 → 就地改」这条路径要最短：
// 直接把那一科交给成绩记录组件打开修改弹窗，然后收起查看弹窗，避免两层弹窗叠着。
function editFromExamModal(subject) {
  const opened = scoreListRef.value?.openBySubject(examDetail.value.exam, subject)
  if (opened) {
    showExamModal.value = false
    return
  }
  // 拿不到成绩行主键（浏览器缓存着旧版页面）时不能静默什么都不做 ——
  // 点了没反应会让教师以为功能坏了，这里说清原因和唯一的解法。
  alert('这条成绩缺少行标识，无法定位到要修改的记录。请刷新页面（Ctrl+F5）后重试。')
}

// ========== 原有逻辑 ==========
onMounted(async () => {
  student.value = await getStudent(route.params.id)
  loading.value = false
  try { subjects.value = await getSubjects() } catch (e) {}
  if (student.value?.aiReport) {
    aiReport.value = student.value.aiReport
    aiSource.value = 'preset'
  }
})

// 成绩改动后重新拉一次档案，图表（成绩趋势）和记录列表同时刷新。
// 不做局部改内存：均分、趋势点、_ids 都要重算，前端自己拼一份极易和库里的真实状态跑偏。
async function reloadStudent() {
  if (!student.value) return
  try {
    student.value = await getStudent(student.value.id)
  } catch (e) {
    scoreMsg.value = '刷新档案失败，请手动刷新页面：' + e.message
    scoreMsgType.value = 'err'
  }
}

async function regenerateAI() {
  if (!student.value) return
  aiLoading.value = true
  aiError.value = ''
  try {
    const result = await generateAIReport(student.value.id)
    if (result?.error) {
      aiError.value = result.error
    } else {
      aiReport.value = result || {}
      aiSource.value = result._source || 'ai'
      if (result._error) aiError.value = 'AI 服务异常，已使用预置报告兜底'
    }
  } catch (err) {
    aiError.value = err.message
    if (student.value?.aiReport) {
      aiReport.value = student.value.aiReport
      aiSource.value = 'fallback'
    }
  } finally {
    aiLoading.value = false
  }
}

async function doAddScore() {
  const f = scoreForm.value
  if (!f.subject || !f.exam_name || f.score === '') { scoreMsg.value = '请填写科目、考试名称与分数'; scoreMsgType.value = 'err'; return }
  scoreLoading.value = true
  scoreMsg.value = ''
  try {
    const base64s = f.images.map(img => img.src)
    const r = await addScore(student.value.id, {
      subject: f.subject,
      exam_name: f.exam_name,
      score: Number(f.score),
      images: base64s
    })
    if (r.success) {
      // 同一场考试的同一科目已存在时后端是覆盖更新（唯一约束），
      // 说成「已添加」会让教师以为多录了一条，回头看到科目数没变又以为没保存。
      const what = r.replaced ? '已更新原有成绩' : '成绩已添加'
      scoreMsg.value = what + (base64s.length ? `（含${base64s.length}张图片）` : '')
      scoreMsgType.value = 'ok'
      f.subject = ''; f.exam_name = ''; f.score = ''; f.images = []
      await reloadStudent()
    } else { scoreMsg.value = r.error || '添加失败'; scoreMsgType.value = 'err' }
  } catch (e) { scoreMsg.value = e.message; scoreMsgType.value = 'err' }
  scoreLoading.value = false
}

async function exportPDF() {
  // 打印前临时退出编辑模式，保证导出的是干净只读版式。
  // window.print() 是同步阻塞的，所以紧接着还原即可，用户感知不到这次切换。
  const wasEditing = editMode.value
  setEditMode(false)
  await nextTick()
  window.print()
  setEditMode(wasEditing)
}

async function doAddEvent() {
  const f = eventForm.value
  if (!f.event_date || !f.event_type || !f.content.trim()) {
    eventMsg.value = '请填写日期、类型和内容'; eventMsgType.value = 'err'; return
  }
  eventLoading.value = true; eventMsg.value = ''
  try {
    const r = await addEvent(student.value.id, {
      event_date: f.event_date, event_type: f.event_type, content: f.content.trim()
    })
    if (r.success) {
      eventMsg.value = '已添加'; eventMsgType.value = 'ok'
      f.event_date = ''; f.event_type = '奖励'; f.content = ''
      student.value = await getStudent(student.value.id)
    } else { eventMsg.value = r.error || '添加失败'; eventMsgType.value = 'err' }
  } catch (e) { eventMsg.value = e.message; eventMsgType.value = 'err' }
  eventLoading.value = false
}

async function doDeleteEvent(i) {
  if (!confirm('确认删除这条记录？')) return
  const e = student.value.events[i]
  const r = await deleteEvent(student.value.id, {
    event_date: e.date, event_type: e.type, content: e.content
  })
  if (r.success) {
    student.value = await getStudent(student.value.id)
  }
}

// ========== 行为评分编辑 ==========
function openBehaviorEdit() {
  const b = student.value.behavior || {}
  behaviorForm.value = {
    raise_hand: Number(b['举手']) || 0,
    focus: Number(b['专注']) || 0,
    cooperation: Number(b['合作']) || 0,
    homework_quality: Number(b['作业质量']) || 0
  }
  behaviorMsg.value = ''
  behaviorEditing.value = true
}

async function doSaveBehavior() {
  const f = behaviorForm.value
  for (const key of Object.keys(f)) {
    if (f[key] < 0 || f[key] > 5) {
      behaviorMsg.value = '所有评分需在 0-5 之间';
      behaviorMsgType.value = 'err';
      return
    }
  }
  behaviorLoading.value = true
  behaviorMsg.value = ''
  try {
    const r = await updateBehavior(student.value.id, f)
    if (r.success) {
      behaviorMsg.value = '已保存'
      behaviorMsgType.value = 'ok'
      setTimeout(() => { behaviorEditing.value = false }, 800)
      student.value = await getStudent(student.value.id)
    } else {
      behaviorMsg.value = r.error || '保存失败'
      behaviorMsgType.value = 'err'
    }
  } catch (e) {
    behaviorMsg.value = e.message
    behaviorMsgType.value = 'err'
  } finally {
    behaviorLoading.value = false
  }
}

// ========== 编辑入口与全局开关的关系 ==========
// 本页所有编辑按钮都由顶栏那个全局「编辑模式」开关统一管辖：
//   开启 → 按钮出现，点开即编辑；
//   关闭 → 按钮消失，页头给出只读提示与「开启编辑模式」出口。
// 这里刻意不做「点编辑按钮时偷偷自动开启编辑模式」：那会让「关闭」形同虚设，
// 也违背「一个开关管全站」的约定。可发现性改由「顶栏常驻开关 + 页头只读提示」保证。

// ========== 作业提交情况编辑 ==========
function openHomeworkEdit() {
  const hw = student.value.homework || {}
  homeworkForm.value = { total: hw.total || 0, missed: hw.missed || 0 }
  homeworkMsg.value = ''
  homeworkEditing.value = true
}

async function doSaveHomework() {
  const t = Number(homeworkForm.value.total)
  const m = Number(homeworkForm.value.missed)
  if (!Number.isInteger(t) || t < 0) {
    homeworkMsg.value = '应交次数需为不小于 0 的整数'; homeworkMsgType.value = 'err'; return
  }
  if (!Number.isInteger(m) || m < 0) {
    homeworkMsg.value = '未交次数需为不小于 0 的整数'; homeworkMsgType.value = 'err'; return
  }
  if (m > t) {
    homeworkMsg.value = '未交次数不能超过应交次数'; homeworkMsgType.value = 'err'; return
  }
  homeworkLoading.value = true
  homeworkMsg.value = ''
  try {
    const r = await updateHomework(student.value.id, { total: t, missed: m })
    if (r.success) {
      homeworkMsg.value = '已保存'
      homeworkMsgType.value = 'ok'
      setTimeout(() => { homeworkEditing.value = false }, 800)
      student.value = await getStudent(student.value.id)
    } else {
      homeworkMsg.value = r.error || '保存失败'
      homeworkMsgType.value = 'err'
    }
  } catch (e) {
    homeworkMsg.value = e.message
    homeworkMsgType.value = 'err'
  } finally {
    homeworkLoading.value = false
  }
}
</script>

<style scoped>
/* =========================================================
   页面头部 + 编辑态提示条
   页面内不再放第二个开关 —— 全站只有一个，在顶栏。
   这里只负责把当前状态说清楚：可编辑时给「完成编辑」出口，
   只读时给「开启编辑模式」出口。
   ========================================================= */
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }

/* 编辑模式提示条
   （对应的只读提示条 .readonly-hint 定义在全局 main.css，
     因为作业管理、学生管理等页面要用同一套说法与外观） */
.edit-banner {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  background: var(--primary-light); border: 1px solid rgba(47, 125, 110, .28);
  border-radius: var(--radius); padding: 12px 16px; margin-bottom: 16px;
}
.edit-banner-icon { font-size: 18px; }
.edit-banner strong { color: var(--primary-dark); font-size: 14px; }
.edit-banner .sub { font-size: 12px; }

/* 卡片标题 + 标题内的操作按钮 */
.card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.card-head .btn { margin-left: auto; }
.h2-hint { font-size: 12px; color: var(--muted); font-weight: 400; }

/* === 作业提交率胶囊 === */
.hw-pill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hw-detail { font-size: 12px; color: var(--muted); }

/* === 作业明细列表 === */
.hw-detail-list { display: flex; flex-direction: column; }
.hw-detail-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 0; border-bottom: 1px dashed var(--line);
}
.hw-detail-row:last-child { border-bottom: none; }
.hw-detail-date { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 84px; }
.hw-detail-title { font-size: 14px; }

/* === 行为评分滑块 === */
.behavior-field { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.behavior-field label { width: 84px; font-size: 14px; color: var(--text); flex-shrink: 0; }
.behavior-field .slider {
  flex: 1; -webkit-appearance: none; appearance: none;
  height: 6px; border-radius: 99px; background: var(--primary-light);
  outline: none;
}
.behavior-field .slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--primary); cursor: pointer;
  box-shadow: 0 1px 4px rgba(47,125,110,.4);
}
.behavior-field .slider::-moz-range-thumb {
  width: 18px; height: 18px; border: none; border-radius: 50%;
  background: var(--primary); cursor: pointer;
}
.behavior-field .slider-val {
  width: 34px; text-align: right; font-weight: 600;
  color: var(--primary); font-variant-numeric: tabular-nums;
}

/* === 作业提交情况表单 === */
.hw-field { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.hw-field label { width: 96px; font-size: 14px; flex-shrink: 0; }
.hw-field .input {
  flex: 1; padding: 8px 12px; border: 1.5px solid #e0e4ea; border-radius: 8px;
  font-size: 14px; color: var(--text); background: #fff; outline: none;
}
.hw-field .input:focus { border-color: var(--primary); }
.hw-preview {
  margin-top: 14px; font-size: 13px; color: var(--muted);
  display: flex; align-items: center; gap: 10px;
}
.hw-preview strong { color: var(--primary); font-size: 15px; }
.hw-bar {
  flex: 1; height: 6px; border-radius: 99px; background: #eef1f5; overflow: hidden;
}
.hw-bar i { display: block; height: 100%; background: var(--primary); border-radius: 99px; transition: width .25s ease; }

.ai-loading { text-align: center; padding: 24px; }
.ai-loading p { color: var(--muted); margin-top: 12px; }
.loading-dots { display: inline-flex; gap: 6px; }
.loading-dots span { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: bounce 1.2s infinite ease-in-out; }
.loading-dots span:nth-child(2) { animation-delay: 0.15s; }
.loading-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
.score-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.score-form .select, .score-form .input {
  padding: 9px 12px; border: 1.5px solid #e0e4ea; border-radius: 8px; font-size: 14px;
  color: var(--text); background: #fff; outline: none;
}
.score-form .input { width: 150px; }
.msg { padding: 10px 16px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
.msg.ok { background: #e8f6ef; color: var(--primary); }
.msg.err { background: #fbe9e9; color: var(--danger); }

/* 图片附件 */
.img-attach { margin-top: 10px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.img-label { cursor: pointer; }
.btn-sm { padding: 5px 12px; font-size: 13px; }
.img-preview-list { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.img-thumb { position: relative; }
.img-thumb img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; border: 1px solid #e0e4ea; }
.img-remove {
  position: absolute; top: -6px; right: -6px;
  width: 18px; height: 18px; border-radius: 50%; background: #ef4444; color: #fff;
  border: none; cursor: pointer; font-size: 10px; line-height: 18px; text-align: center;
  padding: 0;
}

/* 弹窗 */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.modal { background: #fff; border-radius: 12px; width: 90%; max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #eee; }
.modal-head h3 { margin: 0; font-size: 16px; }
.modal-close { background: none; border: none; cursor: pointer; font-size: 18px; color: #999; padding: 0; }
.modal-body { padding: 16px 20px; max-height: 70vh; overflow-y: auto; }
.score-row-list { display: flex; flex-direction: column; gap: 8px; }
.score-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f8f9fa; border-radius: 6px; font-size: 14px; }
.score-row > span:first-child { flex: 1; }
.score-row-val { font-weight: 600; color: var(--primary); font-variant-numeric: tabular-nums; }
/* 每科的「就地修改」入口：编辑模式下才出现，点击直接打开修改弹窗 */
.score-row-edit {
  background: none; border: none; cursor: pointer; padding: 2px 4px;
  font-size: 13px; line-height: 1; border-radius: 4px; opacity: .7;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}
.score-row-edit:hover { opacity: 1; background: var(--primary-light); }
.exam-images { margin-top: 12px; }
.exam-img-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.exam-img { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; cursor: zoom-in; border: 1px solid #e0e4ea; }
.preview-img { max-width: 95vw; max-height: 95vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }

/* 时间线事件管理 */
.event-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.event-form .select, .event-form .input {
  padding: 7px 10px; border: 1.5px solid #e0e4ea; border-radius: 8px; font-size: 13px;
  color: var(--text); background: #fff; outline: none;
}
.del-btn {
  margin-left: 8px; background: none; border: none; cursor: pointer; color: #ccc;
  font-size: 16px; padding: 0 2px; line-height: 1; vertical-align: middle;
  transition: color 0.15s;
}
.del-btn:hover { color: #ef4444; }
</style>
