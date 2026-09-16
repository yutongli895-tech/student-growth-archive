<template>
  <div>
    <!-- 提示条：首次登录强制改密 -->
    <div v-if="mustChangePwd" class="notice">
      ⚠ 您使用的是初始密码，请先修改密码（已为您定位到「我的密码」）
    </div>

    <!-- Tab 切换 -->
    <div class="card">
      <div class="tabs">
        <button :class="['tab', { active: tab === 'students' }]" @click="switchTab('students')">学生管理</button>
        <button v-if="isStaff" :class="['tab', { active: tab === 'scores' }]" @click="switchTab('scores')">成绩导入</button>
        <button v-if="isAdmin" :class="['tab', { active: tab === 'teachers' }]" @click="switchTab('teachers')">教师管理</button>
        <button v-if="isAdmin" :class="['tab', { active: tab === 'invites' }]" @click="switchTab('invites')">邀请码管理</button>
        <button v-if="isStaff" :class="['tab', { active: tab === 'parents' }]" @click="switchTab('parents')">家长管理</button>
        <button :class="['tab', { active: tab === 'pwd' }]" @click="switchTab('pwd')">我的密码</button>
      </div>
    </div>

    <div v-if="msg" :class="['msg', msgType]">{{ msg }}</div>

    <!-- 只读提示：本页的写入入口（添加/导入/编辑/删除学生、教师账号、邀请码、家长绑定）
         统一受顶栏那个全局「编辑模式」管辖。
         「我的密码」属于账号安全，不属于「信息编辑」，因此不受此开关影响。 -->
    <div v-if="!canEdit" class="readonly-hint">
      <span class="rh-icon">🔒</span>
      <span><span class="rh-strong">当前为只读模式</span>，添加 / 导入 / 编辑 / 删除类操作均已关闭（修改自己的密码不受影响）。</span>
      <button class="btn sm outline" @click="toggleEditMode">开启编辑模式</button>
    </div>

    <!-- ============ 学生管理 ============ -->
    <div v-show="tab === 'students'">
      <div class="card">
        <div class="row between">
          <h2>学生列表 <span v-if="allStudents.length" class="h2-count">共 {{ allStudents.length }} 人</span></h2>
          <div class="row">
            <select v-model="filterClass" class="select" @change="loadStudents">
              <option value="">全部班级</option>
              <option v-for="c in classrooms" :key="c" :value="c">{{ c }}</option>
            </select>
            <!-- 学生录入相关入口整组受编辑模式管辖。
                 连「下载模板」一起收起，避免出现「能下模板却不能导入」的半截状态。 -->
            <template v-if="canEdit">
              <button class="btn" @click="showAdd = true">+ 单条添加</button>
              <button class="btn outline" @click="downloadTemplate">下载模板</button>
              <label class="btn outline">
                批量导入
                <input type="file" accept=".csv" hidden @change="onFile" />
              </label>
            </template>
          </div>
        </div>

        <!-- 批量操作条：整组受编辑模式管辖。
             它要解决的问题是「导入出错后没法收拾」——
             逐条删除时每删一个都要重拉一次名单，名单一长就会把页面拖进
             Cloudflare 的资源上限（503 + 列表空白 + 什么都点不了）。 -->
        <div v-if="canEdit" class="bulk-bar">
          <label class="bulk-check">
            <input ref="selectAllBox" type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
            <span>全选当前列表</span>
          </label>
          <span class="spacer"></span>
          <template v-if="selectedIds.length">
            <span class="bulk-count">已选 <strong>{{ selectedIds.length }}</strong> 人</span>
            <button class="btn outline sm" @click="clearSelection">取消选择</button>
            <button class="btn danger sm" @click="showBulkDelete = true">批量删除</button>
          </template>
        </div>

        <div class="grid">
          <div
            v-for="s in students"
            :key="s.id"
            :class="['student-card', { selected: isSelected(s.id) }]"
            @click="$router.push('/student/' + s.id)"
          >
            <label v-if="canEdit" class="card-select" :title="isSelected(s.id) ? '取消勾选' : '勾选后可批量删除'" @click.stop>
              <input type="checkbox" :checked="isSelected(s.id)" @change="toggleSelect(s.id)" />
            </label>
            <div class="avatar">{{ s.name.charAt(0) }}</div>
            <div class="meta">
              <div class="name">{{ s.name }}</div>
              <div class="sub">{{ s.className }}</div>
            </div>
            <span class="badge" :class="{ warn: s.homeworkRate < 0.9 }">作业 {{ Math.round(s.homeworkRate * 100) }}%</span>
            <!-- 查看档案（整张卡片可点）在只读模式下依然可用，只收起改数据的按钮 -->
            <div v-if="canEdit" class="card-actions no-print">
              <button class="btn outline sm" @click.stop="openEditStudent(s)">编辑</button>
              <button class="btn danger sm" @click.stop="askDeleteStudent(s)">删除</button>
            </div>
          </div>
          <div v-if="!students.length" class="empty">
            {{ canEdit ? '暂无学生，点击「单条添加」或「批量导入」' : '暂无学生' }}
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 成绩导入 ============ -->
    <div v-show="tab === 'scores' && isStaff">
      <!-- 这个 tab 本身就是纯写入功能，只读时直接给出口，不留一个点了没用的空壳表单 -->
      <div v-if="!canEdit" class="readonly-hint">
        <span class="rh-icon">🔒</span>
        <span><span class="rh-strong">成绩导入已关闭</span>：当前为只读模式，开启后才能批量导入成绩。</span>
        <button class="btn sm outline" @click="toggleEditMode">开启编辑模式</button>
      </div>
      <div v-else class="card">
        <div class="row between">
          <h2>批量导入成绩</h2>
          <button class="btn outline" @click="downloadScoreTemplate">下载模板</button>
        </div>
        <div class="field" style="margin-top:16px">
          <label>CSV 文件</label>
          <input type="file" accept=".csv" @change="onScoreFile" class="input" style="padding:8px" />
          <div style="font-size:12px;color:var(--muted);margin-top:6px">
            格式：学号,考试名称,科目,分数（UTF-8 或 GBK 编码）
          </div>
        </div>
        <div v-if="scoreImportResult" class="result-box" :class="scoreImportResult.success ? 'ok' : 'err'">
          <div>导入完成：成功 {{ scoreImportResult.imported }} 条，跳过 {{ scoreImportResult.skipped }} 条</div>
          <div v-if="scoreImportResult.errors && scoreImportResult.errors.length">
            <div style="margin-top:8px;color:var(--danger)">错误（{{ scoreImportResult.errors.length }} 条）：</div>
            <ul style="margin:4px 0 0 20px;font-size:13px">
              <li v-for="(e,i) in scoreImportResult.errors.slice(0,10)" :key="i">第{{ e.row }}行: {{ e.reason }}</li>
            </ul>
            <div v-if="scoreImportResult.errors.length > 10">... 共 {{ scoreImportResult.errors.length }} 条错误</div>
          </div>
        </div>
        <div class="tip-box" style="margin-top:12px">
          <strong>示例：</strong>
          <pre style="margin:8px 0 0;font-size:12px;color:var(--muted)">学号,考试名称,科目,分数
2024001,月考1,语文,85
2024001,月考1,数学,90
2024002,月考1,语文,88</pre>
        </div>

        <!-- 作业数据批量录入已归到「作业管理」，此处给出入口避免找不到 -->
        <div class="tip-box" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span>作业提交数据的批量录入（汇总式 / 明细式 CSV）已移至「作业管理」页。</span>
          <button class="btn outline sm" @click="$router.push('/homework')">前往作业管理 →</button>
        </div>
      </div>
    </div>

    <!-- ============ 教师管理（仅管理员） ============ -->
    <div v-show="tab === 'teachers' && isAdmin">
      <div class="card">
        <div class="row between">
          <h2>教师账号</h2>
          <button v-if="canEdit" class="btn" @click="showAddTeacher = true">+ 添加教师</button>
        </div>
        <!-- 名单本身是只读信息，任何模式下都保留；只有改账号的按钮受编辑模式管辖 -->
        <table class="tbl">
          <thead>
            <tr><th>工号</th><th>姓名</th><th>角色</th><th>班级</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in teachers" :key="t.id">
              <td>{{ t.account }}</td>
              <td>{{ t.name }}</td>
              <td>{{ t.role === 'admin' ? '管理员' : '教师' }}</td>
              <td>{{ t.class_name }}</td>
              <td>{{ t.status === 'active' ? '正常' : t.status }}</td>
              <td>
                <template v-if="canEdit">
                  <button class="btn outline sm" @click="openEditTeacher(t)">编辑</button>
                  <button class="btn danger sm" @click="askDeleteTeacher(t)">删除</button>
                </template>
                <span v-else class="sub">只读</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ 邀请码管理（仅管理员） ============ -->
    <div v-show="tab === 'invites' && isAdmin">
      <InviteManager />
    </div>

    <!-- ============ 家长管理（教师/管理员） ============ -->
    <div v-show="tab === 'parents' && isStaff">
      <ParentManager />
    </div>

    <!-- ============ 我的密码 ============ -->
    <div v-show="tab === 'pwd'">
      <div class="card" style="max-width:480px">
        <h2>修改密码</h2>
        <div class="field">
          <label>原密码</label>
          <input v-model="oldPwd" type="password" class="input" />
        </div>
        <div class="field">
          <label>新密码（至少 6 位）</label>
          <input v-model="newPwd" type="password" class="input" />
        </div>
        <button class="btn" :disabled="pwdLoading" @click="doChangePwd">{{ pwdLoading ? '提交中…' : '确认修改' }}</button>
      </div>
    </div>

    <!-- 以下四个编辑弹窗统一受全局编辑模式管辖。
         外层再包一层 canEdit 做纵深防御：万一将来新增入口漏了判断，
         也不会出现「开关已关、弹窗却仍能提交」的旁路。 -->
    <template v-if="canEdit">
    <!-- ============ 批量删除学生 模态 ============ -->
    <!-- 破坏性操作不做成 window.confirm：那个框既列不清影响范围、也不能强调
         「关联数据会一起删」。导入出错后要清掉几十条时，这一步必须看得清楚。 -->
    <div v-if="showBulkDelete" class="modal-mask" @click.self="showBulkDelete = false">
      <div class="modal">
        <h3>确认删除 {{ selectedIds.length }} 名学生？</h3>
        <p class="modal-warn">
          ⚠️ 此操作不可撤销。这些学生的<strong>成绩、行为评分、作业记录、成长事件、家长关联</strong>都会一并删除。
        </p>
        <div class="del-list">
          <span v-for="s in selectedStudents.slice(0, 15)" :key="s.id" class="del-chip">{{ s.name }}</span>
          <span v-if="selectedStudents.length > 15" class="del-chip more">…等共 {{ selectedStudents.length }} 人</span>
        </div>
        <p class="modal-hint">
          如果这些学生只是班级填错了，请改用「编辑」把班级改到正确值，这样成绩和作业记录都能保住。
        </p>
        <div class="modal-actions">
          <button class="btn outline" @click="showBulkDelete = false">取消</button>
          <button class="btn danger" :disabled="bulkDeleting" @click="doBulkDelete">
            {{ bulkDeleting ? '删除中…' : `确认删除 ${selectedIds.length} 人` }}
          </button>
        </div>
      </div>
    </div>

    <!-- ============ 批量导入预览 模态 ============ -->
    <!-- 导入是唯一能一次性造出大量数据的入口，所以提交前必须先看清「会变成什么」。
         以前是解析完直接写库，文件格式不对就留下几十条脏数据，
         只能靠人一条条删 —— 这次线上事故就是这么来的。 -->
    <div v-if="showImportPreview" class="modal-mask" @click.self="closeImport">
      <div class="modal modal-wide">
        <h3>批量导入预览</h3>
        <div class="imp-file">
          {{ importFileName }} · 共 {{ importRows.length }} 行
        </div>

        <div class="imp-stats">
          <span class="imp-stat ok">可导入 <strong>{{ importValid.length }}</strong></span>
          <span v-if="importSkippedCount" class="imp-stat warn">已存在（跳过）<strong>{{ importSkippedCount }}</strong></span>
          <span v-if="importProblems.length" class="imp-stat bad">无法导入 <strong>{{ importProblems.length }}</strong></span>
        </div>

        <div v-if="!importValid.length && importProblems.length" class="imp-block">
          整个文件没有一行可以导入。请检查表头是否为「学号,姓名,班级,初始密码」，以及班级列是否填了真实班级。
        </div>

        <div class="imp-table-wrap">
          <table class="imp-table">
            <thead>
              <tr><th>行</th><th>学号</th><th>姓名</th><th>班级</th><th>结果</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="r in importPreviewRows"
                :key="r.row"
                :class="{ bad: r.level === 'bad', skip: r.level === 'skip' }"
              >
                <td class="num">{{ r.row }}</td>
                <td>{{ r.account || '—' }}</td>
                <td>{{ r.name || '—' }}</td>
                <td>{{ r.className || '—' }}</td>
                <td class="imp-reason">{{ r.reason || '可导入' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="importPreviewRows.length < importRows.length" class="imp-more">
            仅展示前 {{ importPreviewRows.length }} 行，其余 {{ importRows.length - importPreviewRows.length }} 行同理处理
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn outline" @click="closeImport">取消</button>
          <button class="btn" :disabled="!importValid.length || importLoading" @click="doImport">
            {{ importLoading ? '导入中…' : `确认导入 ${importValid.length} 人` }}
          </button>
        </div>
      </div>
    </div>

    <!-- ============ 单条添加学生 模态 ============ -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal">
        <h3>添加学生</h3>
        <div class="field"><label>学号 *</label><input v-model="form.account" class="input" placeholder="如 2024005" /></div>
        <div class="field"><label>姓名 *</label><input v-model="form.name" class="input" placeholder="如 张三" /></div>
        <div class="field"><label>班级 *</label><input v-model="form.className" class="input" placeholder="如 高三(2)班" /></div>
        <div class="field"><label>初始密码（留空=学号）</label><input v-model="form.password" class="input" placeholder="留空则默认学号" /></div>
        <div class="modal-actions">
          <button class="btn outline" @click="showAdd = false">取消</button>
          <button class="btn" :disabled="addLoading" @click="doAddStudent">{{ addLoading ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 添加教师 模态 ============ -->
    <div v-if="showAddTeacher" class="modal-mask" @click.self="showAddTeacher = false">
      <div class="modal">
        <h3>添加教师</h3>
        <div class="field"><label>工号 *</label><input v-model="tForm.account" class="input" placeholder="如 T2025" /></div>
        <div class="field"><label>姓名 *</label><input v-model="tForm.name" class="input" /></div>
        <div class="field"><label>初始密码 *</label><input v-model="tForm.password" class="input" type="password" /></div>
        <div class="field"><label>角色 *</label>
          <select v-model="tForm.role" class="select"><option value="teacher">教师</option><option value="admin">管理员</option></select>
        </div>
        <div class="field"><label>负责班级 *</label><input v-model="tForm.className" class="input" placeholder="如 高三(2)班" /></div>
        <div class="modal-actions">
          <button class="btn outline" @click="showAddTeacher = false">取消</button>
          <button class="btn" :disabled="tLoading" @click="doAddTeacher">{{ tLoading ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 编辑学生 模态 ============ -->
    <div v-if="showEditStudent" class="modal-mask" @click.self="showEditStudent = false">
      <div class="modal">
        <h3>编辑学生</h3>
        <div class="field"><label>学号</label><input :value="editStudentForm.id" class="input" disabled /></div>
        <div class="field"><label>姓名 *</label><input v-model="editStudentForm.name" class="input" /></div>
        <div class="field"><label>班级 *</label><input v-model="editStudentForm.className" class="input" /></div>
        <div class="field"><label>重置密码（留空则不修改）</label><input v-model="editStudentForm.password" class="input" type="password" placeholder="留空不改" /></div>
        <div class="modal-actions">
          <button class="btn outline" @click="showEditStudent = false">取消</button>
          <button class="btn" :disabled="editLoading" @click="doEditStudent">{{ editLoading ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ============ 编辑教师 模态 ============ -->
    <div v-if="showEditTeacher" class="modal-mask" @click.self="showEditTeacher = false">
      <div class="modal">
        <h3>编辑教师/管理员</h3>
        <div class="field"><label>工号</label><input :value="editTeacherForm.id" class="input" disabled /></div>
        <div class="field"><label>姓名 *</label><input v-model="editTeacherForm.name" class="input" /></div>
        <div class="field"><label>角色 *</label>
          <select v-model="editTeacherForm.role" class="select"><option value="teacher">教师</option><option value="admin">管理员</option></select>
        </div>
        <div class="field"><label>负责班级 *</label><input v-model="editTeacherForm.className" class="input" /></div>
        <div class="field"><label>重置密码（留空则不修改）</label><input v-model="editTeacherForm.password" class="input" type="password" placeholder="留空不改" /></div>
        <div class="modal-actions">
          <button class="btn outline" @click="showEditTeacher = false">取消</button>
          <button class="btn" :disabled="editTeacherLoading" @click="doEditTeacher">{{ editTeacherLoading ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, watchEffect, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { getRole, getUser, getMustChangePwd, changePassword, updateTeacher, deleteTeacher } from '../api/auth.js'
import InviteManager from '../components/InviteManager.vue'
import ParentManager from '../components/ParentManager.vue'
import { getStudents, getClassrooms, createStudent, importStudents, importScores, getTeachers, createTeacher, updateStudent, deleteStudent, bulkDeleteStudents } from '../api/student.js'
import { readTextFile, downloadCSV } from '../utils/csv.js'
import { parseStudentCSV, buildImportPreview, fallbackClassOf } from '../utils/studentImport.js'
import { useEditMode } from '../utils/editMode.js'

const route = useRoute()
const isAdmin = getRole() === 'admin'
const isStaff = getRole() === 'teacher' || getRole() === 'admin'
const mustChangePwd = getMustChangePwd()

const tab = ref('students')
const msg = ref('')
const msgType = ref('ok')

const students = ref([])        // 当前筛选后展示的列表
const allStudents = ref([])     // 未筛选的完整名单（用于导入查重与总数展示）
const classrooms = ref([])
const filterClass = ref('')
const teachers = ref([])

// 批量删除
const selectedIds = ref([])
const showBulkDelete = ref(false)
const bulkDeleting = ref(false)
const selectAllBox = ref(null)

// 批量导入预览
const showImportPreview = ref(false)
const importRows = ref([])
const importFileName = ref('')
const importLoading = ref(false)

const showAdd = ref(false)
const showAddTeacher = ref(false)
const addLoading = ref(false)
const tLoading = ref(false)
const pwdLoading = ref(false)

// 编辑/删除
const showEditStudent = ref(false)
const editStudentForm = ref({ id: '', name: '', className: '', password: '' })
const editLoading = ref(false)
const showEditTeacher = ref(false)
const editTeacherForm = ref({ id: '', name: '', className: '', role: 'teacher', password: '' })
const editTeacherLoading = ref(false)

const form = ref({ account: '', name: '', className: '', password: '' })
const tForm = ref({ account: '', name: '', password: '', role: 'teacher', className: '' })
const oldPwd = ref('')
const newPwd = ref('')

// 全局编辑模式：本页的增删改入口全部由它统一管辖。
// 「我的密码」不属于信息编辑，因此不接这个闸门。
const { editMode, canEdit, toggleEditMode } = useEditMode()

// 关掉编辑模式时，把还开着的编辑弹窗一并收起 ——
// 否则弹窗里的「保存」会成为绕过开关的旁路。
watch(editMode, on => {
  if (!on) {
    showAdd.value = false
    showAddTeacher.value = false
    showEditStudent.value = false
    showEditTeacher.value = false
    showBulkDelete.value = false
    showImportPreview.value = false
    // 勾选态也一并清掉：留着会让「已选 N 人」这个提示在只读态下继续显示
    selectedIds.value = []
  }
})

// ===== 勾选与批量删除 =====
const allSelected = computed(() =>
  students.value.length > 0 && students.value.every(s => selectedIds.value.includes(s.id))
)
const selectedStudents = computed(() => students.value.filter(s => selectedIds.value.includes(s.id)))

const isSelected = id => selectedIds.value.includes(id)

function toggleSelect(id) {
  selectedIds.value = isSelected(id)
    ? selectedIds.value.filter(x => x !== id)
    : [...selectedIds.value, id]
}
function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : students.value.map(s => s.id)
}
function clearSelection() { selectedIds.value = [] }

// 半选态（勾了一部分）只能靠 DOM 属性表达，模板里没有对应写法
watchEffect(() => {
  if (selectAllBox.value) {
    selectAllBox.value.indeterminate = selectedIds.value.length > 0 && !allSelected.value
  }
})

// ===== 批量导入预览 =====
// 解析与逐行校验都在 src/utils/studentImport.js 里（纯函数、可单测），
// 这里只负责把结果接到界面上。
const importPreview = computed(() =>
  buildImportPreview(importRows.value, {
    // 兜底班级 = 导入者自己的班级；「全部班级」是哨兵，等于「没有班级」
    fallbackClass: fallbackClassOf(getUser()),
    existingAccounts: new Set(allStudents.value.map(s => s.id))
  })
)
const importValid = computed(() => importPreview.value.filter(r => r.level === 'ok'))
const importProblems = computed(() => importPreview.value.filter(r => r.level === 'bad'))
const importSkippedCount = computed(() => importPreview.value.filter(r => r.level === 'skip').length)
// 预览表上限 200 行：再长的表格既看不过来也拖慢渲染，问题行另用统计数说明
const importPreviewRows = computed(() => importPreview.value.slice(0, 200))

// 成绩导入状态
const scoreImportResult = ref(null)
const scoreLoading = ref(false)

function setMsg(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000) }
function switchTab(t) { tab.value = t; if (t === 'teachers') loadTeachers() }

async function loadStudents() {
  try {
    const all = await getStudents()
    allStudents.value = all
    students.value = filterClass.value ? all.filter(s => s.className === filterClass.value) : all
    // 切班级后要丢掉看不见的勾选，否则「批量删除」会删到当前列表里没有的人
    const visible = new Set(students.value.map(s => s.id))
    selectedIds.value = selectedIds.value.filter(id => visible.has(id))
  } catch (e) { setMsg(e.message, 'err') }
}

async function loadTeachers() {
  if (!isAdmin) return
  try { teachers.value = await getTeachers() } catch (e) { setMsg(e.message, 'err') }
}

function downloadTemplate() {
  downloadCSV('学生导入模板.csv', '学号,姓名,班级,初始密码\n2024005,张三,高三(2)班,\n2024006,李四,高三(2)班,\n')
}
function downloadScoreTemplate() {
  downloadCSV('成绩导入模板.csv', '学号,考试名称,科目,分数\n2024001,月考1,语文,85\n2024001,月考1,数学,90\n2024002,月考1,语文,88\n')
}

async function onScoreFile(e) {
  const file = e.target.files[0]
  if (!file) return
  
  // GBK/UTF-8 检测
  async function readFileAsText(file) {
    const buffer = await file.arrayBuffer()
    try {
      const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (/[\u4e00-\u9fa5]/.test(utf8Text)) return utf8Text
    } catch (e) {}
    try {
      const gbkText = new TextDecoder('gbk', { fatal: true }).decode(buffer)
      if (/[\u4e00-\u9fa5]/.test(gbkText)) return gbkText
    } catch (e) {}
    return new TextDecoder('utf-8').decode(buffer)
  }
  
  const text = await readFileAsText(file)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  
  if (lines.length < 2) {
    setMsg('文件内容为空或只有表头', 'err')
    e.target.value = ''
    return
  }
  
  // 解析 CSV
  const scores = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    if (c.length >= 4) {
      scores.push({
        '学号': c[0]?.trim(),
        '考试名称': c[1]?.trim(),
        '科目': c[2]?.trim(),
        '分数': parseFloat(c[3]?.trim()) || 0
      })
    }
  }
  
  if (!scores.length) {
    setMsg('未解析到有效数据', 'err')
    e.target.value = ''
    return
  }
  
  scoreLoading.value = true
  scoreImportResult.value = null
  try {
    const r = await importScores(scores)
    scoreImportResult.value = r
    if (r.errors && r.errors.length) {
      setMsg(`导入完成：成功 ${r.imported} 条，失败 ${r.errors.length} 条`, 'warn')
    } else {
      setMsg(`成功导入 ${r.imported} 条成绩`, 'ok')
    }
  } catch (err) {
    setMsg(err.message, 'err')
  }
  scoreLoading.value = false
  e.target.value = ''
}

function parseCSV(text) {
  // 实现在 src/utils/studentImport.js（纯函数，可单测）
  return parseStudentCSV(text)
}

// GBK -> UTF-8 转换（处理 Excel 导出的 GBK CSV）已统一到 src/utils/csv.js

// 选好文件 → 先解析 + 预览，不直接写库
async function onFile(e) {
  const file = e.target.files[0]
  if (!file) return
  try {
    const text = await readTextFile(file)
    const rows = parseCSV(text)
    if (!rows.length) {
      setMsg('这个文件里没有数据行。请确认第一行是表头「学号,姓名,班级,初始密码」，并先用「下载模板」对照一下格式。', 'err')
      return
    }
    importRows.value = rows
    importFileName.value = file.name
    showImportPreview.value = true
  } catch (err) {
    setMsg('读取文件失败：' + err.message, 'err')
  } finally {
    e.target.value = ''
  }
}

function closeImport() {
  showImportPreview.value = false
  importRows.value = []
  importFileName.value = ''
}

// 预览里确认后，才真正提交
async function doImport() {
  const payload = importValid.value.map(r => ({
    account: r.account,
    name: r.name,
    className: r.className,
    password: r.password
  }))
  if (!payload.length) return

  importLoading.value = true
  try {
    const r = await importStudents(payload)
    let m = `导入完成：新增 ${r.created} 人`
    if (r.skipped) m += `，跳过重复 ${r.skipped} 人`
    if (r.errors && r.errors.length) m += `，失败 ${r.errors.length} 行`
    setMsg(m, r.errors && r.errors.length ? 'warn' : 'ok')
    if (r.errors && r.errors.length) console.warn('导入错误:', r.errors)
    closeImport()
    await loadStudents()
  } catch (err) {
    setMsg(err.message, 'err')
  }
  importLoading.value = false
}

// 批量删除：一次请求清一批（逐个删会把名单一遍遍重拉，正是卡死的成因）
async function doBulkDelete() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  bulkDeleting.value = true
  try {
    const r = await bulkDeleteStudents(ids)
    let m = `已删除 ${r.removed} 名学生`
    if (r.skipped && r.skipped.length) m += `，${r.skipped.length} 条未删除（${r.skipped[0].reason}）`
    setMsg(m, r.skipped && r.skipped.length ? 'warn' : 'ok')
    showBulkDelete.value = false
    clearSelection()
    await loadStudents()
  } catch (err) {
    setMsg(err.message, 'err')
  }
  bulkDeleting.value = false
}

async function doAddStudent() {
  const f = form.value
  if (!f.account || !f.name || !f.className) { setMsg('学号、姓名、班级为必填', 'err'); return }
  addLoading.value = true
  try {
    const r = await createStudent(f)
    if (r.success) { setMsg(`已添加学生 ${f.name}`, 'ok'); showAdd.value = false; form.value = { account: '', name: '', className: '', password: '' }; loadStudents() }
    else setMsg(r.error || '添加失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
  addLoading.value = false
}

async function doAddTeacher() {
  const f = tForm.value
  if (!f.account || !f.name || !f.password || !f.className) { setMsg('请填写完整', 'err'); return }
  tLoading.value = true
  try {
    const r = await createTeacher(f)
    if (r.success) { setMsg(`已添加教师 ${f.name}`, 'ok'); showAddTeacher.value = false; tForm.value = { account: '', name: '', password: '', role: 'teacher', className: '' }; loadTeachers() }
    else setMsg(r.error || '添加失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
  tLoading.value = false
}

// ===== 学生编辑/删除（教师/管理员）=====
function openEditStudent(s) {
  editStudentForm.value = { id: s.id, name: s.name, className: s.className, password: '' }
  showEditStudent.value = true
}
async function doEditStudent() {
  const f = editStudentForm.value
  if (!f.name || !f.className) { setMsg('姓名、班级为必填', 'err'); return }
  editLoading.value = true
  try {
    const payload = { name: f.name, className: f.className }
    if (f.password) payload.resetPassword = f.password
    const r = await updateStudent(f.id, payload)
    if (r.success) { setMsg('学生信息已更新', 'ok'); showEditStudent.value = false; loadStudents() }
    else setMsg(r.error || '更新失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
  editLoading.value = false
}
async function askDeleteStudent(s) {
  if (!confirm(`确认删除学生 ${s.name}（${s.id}）？将同时删除其成绩、行为、事件等全部数据。`)) return
  try {
    const r = await deleteStudent(s.id)
    if (r.success) { setMsg('已删除', 'ok'); loadStudents() }
    else setMsg(r.error || '删除失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
}

// ===== 教师编辑/删除（管理员）=====
function openEditTeacher(t) {
  editTeacherForm.value = { id: t.id, name: t.name, className: t.class_name, role: t.role || 'teacher', password: '' }
  showEditTeacher.value = true
}
async function doEditTeacher() {
  const f = editTeacherForm.value
  if (!f.name || !f.className) { setMsg('姓名、班级为必填', 'err'); return }
  editTeacherLoading.value = true
  try {
    const payload = { name: f.name, className: f.className, role: f.role }
    if (f.password) payload.resetPassword = f.password
    const r = await updateTeacher(f.id, payload)
    if (r.ok) { setMsg('教师信息已更新', 'ok'); showEditTeacher.value = false; loadTeachers() }
    else setMsg((r.data && r.data.error) || '更新失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
  editTeacherLoading.value = false
}
async function askDeleteTeacher(t) {
  if (!confirm(`确认删除教师/管理员 ${t.name}（${t.account}）？`)) return
  try {
    const r = await deleteTeacher(t.id)
    if (r.ok) { setMsg('已删除', 'ok'); loadTeachers() }
    else setMsg((r.data && r.data.error) || '删除失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
}

async function doChangePwd() {
  if (!oldPwd.value || !newPwd.value) { setMsg('请填写完整', 'err'); return }
  if (newPwd.value.length < 6) { setMsg('新密码至少 6 位', 'err'); return }
  pwdLoading.value = true
  try {
    const r = await changePassword(oldPwd.value, newPwd.value)
    if (r.success) { setMsg('密码已修改', 'ok'); oldPwd.value = ''; newPwd.value = ''; mustChangePwd && (mustChangePwd.value = false) }
    else setMsg(r.error || '修改失败', 'err')
  } catch (e) { setMsg(e.message, 'err') }
  pwdLoading.value = false
}

onMounted(async () => {
  const q = route.query.tab
  if (q === 'pwd' || q === 'teachers' || q === 'students' || q === 'invites' || q === 'parents') tab.value = q
  if (mustChangePwd.value) tab.value = 'pwd'
  try { classrooms.value = await getClassrooms() } catch {}
  loadStudents()
  if (isAdmin && tab.value === 'teachers') loadTeachers()
})

watch(() => route.query.tab, (t) => { if (t) tab.value = t })
</script>

<style scoped>
.tabs { display: flex; gap: 8px; }
.tab {
  padding: 10px 20px; border: none; background: var(--bg); color: var(--muted);
  border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500;
}
.tab.active { background: var(--primary); color: #fff; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.select, .input {
  padding: 9px 12px; border: 1.5px solid #e0e4ea; border-radius: 8px; font-size: 14px;
  color: var(--text); background: #fff; outline: none;
}
.select:focus, .input:focus { border-color: var(--primary); }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text); }
.empty { padding: 24px; text-align: center; color: var(--muted); }
.tbl { width: 100%; border-collapse: collapse; font-size: 14px; }
.tbl th, .tbl td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef1f5; }
.tbl th { color: var(--muted); font-weight: 600; }
.notice {
  background: #fdf3e0; color: var(--warn); padding: 10px 16px; border-radius: 8px;
  margin-bottom: 16px; font-size: 14px;
}
.msg { padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
.msg.ok { background: #e8f6ef; color: var(--primary); }
.msg.warn { background: #fdf3e0; color: var(--warn); }
.msg.err { background: #fbe9e9; color: var(--danger); }
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex;
  align-items: center; justify-content: center; z-index: 100;
}
.modal { background: #fff; border-radius: 12px; padding: 24px; width: 380px; max-width: 92vw; box-shadow: 0 8px 40px rgba(0,0,0,0.2); }
.modal h3 { margin-bottom: 16px; color: var(--primary); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.btn.sm { padding: 5px 10px; font-size: 12px; }
.btn.danger { background: var(--danger); }
.btn.danger:hover { opacity: 0.9; }
.student-card { flex-wrap: wrap; }
.card-actions { flex-basis: 100%; display: flex; gap: 6px; margin-top: 6px; }
.result-box { padding: 12px 16px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
.result-box.ok { background: #e8f6ef; color: var(--primary); }
.result-box.err { background: #fbe9e9; color: var(--danger); }
.tip-box { background: #f8f9fa; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: var(--muted); }

/* =========================================================
   批量选择 / 批量删除
   设计意图：导入出错后要清掉几十条数据时，「选中范围」和
   「将失去什么」必须一眼看清 —— 这类操作没有撤销。
   ========================================================= */
.h2-count { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 4px; }

.bulk-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--bg); border: 1px dashed var(--line);
  border-radius: 8px; padding: 8px 12px; margin: 4px 0 14px;
}
.bulk-check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); cursor: pointer; }
.bulk-check input { width: 15px; height: 15px; accent-color: var(--primary); cursor: pointer; }
.bulk-count { font-size: 13px; color: var(--text); }
.bulk-count strong { color: var(--danger); font-variant-numeric: tabular-nums; }

.card-select {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer;
}
.card-select input { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }
/* 选中的卡片给出明确边框，避免「以为没选中」而误删 */
.student-card { position: relative; }
.student-card.selected {
  outline: 2px solid var(--primary); outline-offset: -2px;
  border-color: var(--primary); background: var(--primary-light);
}

/* =========================================================
   破坏性操作确认
   ========================================================= */
.modal-warn {
  background: var(--danger-light); color: var(--danger); border-radius: 8px;
  padding: 10px 14px; font-size: 13.5px; line-height: 1.65; margin-bottom: 14px;
}
.modal-hint { font-size: 12.5px; color: var(--muted); line-height: 1.6; margin: 12px 0 4px; }
.del-list { display: flex; flex-wrap: wrap; gap: 6px; max-height: 132px; overflow-y: auto; }
.del-chip {
  background: var(--bg); border: 1px solid var(--line); border-radius: 99px;
  padding: 3px 10px; font-size: 12.5px; color: var(--text);
}
.del-chip.more { color: var(--muted); border-style: dashed; }

/* =========================================================
   导入预览
   导入是唯一能一次造出大量数据的入口，所以先看清楚再落库。
   ========================================================= */
.modal-wide { width: 620px; max-height: 84vh; overflow-y: auto; }
.imp-file { font-size: 13px; color: var(--muted); margin-bottom: 12px; word-break: break-all; }
.imp-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.imp-stat {
  border-radius: 99px; padding: 4px 12px; font-size: 12.5px; font-weight: 500;
  background: var(--bg); color: var(--muted);
}
.imp-stat strong { font-variant-numeric: tabular-nums; margin-left: 2px; }
.imp-stat.ok { background: #e8f6ef; color: var(--primary); }
.imp-stat.warn { background: var(--warn-light); color: var(--warn); }
.imp-stat.bad { background: var(--danger-light); color: var(--danger); }
.imp-block {
  background: var(--danger-light); color: var(--danger); border-radius: 8px;
  padding: 10px 14px; font-size: 13px; line-height: 1.65; margin-bottom: 12px;
}
.imp-table-wrap { border: 1px solid var(--line); border-radius: 8px; max-height: 320px; overflow: auto; }
.imp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.imp-table th {
  position: sticky; top: 0; background: #f7f9fb; color: var(--muted);
  font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line);
}
.imp-table td { padding: 7px 10px; border-bottom: 1px solid #f2f4f7; color: var(--text); }
.imp-table td.num { color: var(--muted); font-variant-numeric: tabular-nums; }
.imp-table tr.bad td { background: #fdf6f6; }
.imp-table tr.bad .imp-reason { color: var(--danger); }
.imp-table tr.skip td { background: #fdfaf3; }
.imp-table tr.skip .imp-reason { color: var(--warn); }
.imp-more { padding: 8px 10px; font-size: 12.5px; color: var(--muted); background: #fafbfc; }
</style>
