<template>
  <div class="card no-print">
    <h2 class="srec-head">
      成绩记录
      <span class="srec-hint">共 {{ flat.rowCount }} 条 · 录入有误可在此修改</span>
      <span v-if="flat.suspectCount" class="badge danger" :title="`有 ${flat.suspectCount} 条分数超出常规 0–100，可能是录入笔误`">
        ⚠ {{ flat.suspectCount }} 条分数异常
      </span>
    </h2>

    <p v-if="!flat.rowCount" class="srec-empty">
      还没有成绩记录，可在上方「添加成绩」录入，或到「管理 → 成绩导入」批量导入。
    </p>

    <template v-else>
      <p v-if="flat.unaddressable" class="srec-warn">
        有 {{ flat.unaddressable }} 条记录缺少行标识（通常是浏览器缓存了旧版页面），
        请刷新页面后再修改，否则改动可能落到错误的记录上。
      </p>

      <div class="srec-groups">
        <section v-for="g in flat.groups" :key="g.exam" class="srec-group">
          <div class="srec-group-head">
            <span class="srec-exam">{{ g.exam }}</span>
            <span class="srec-group-meta">{{ g.count }} 科 · 均分 {{ g.avg }}</span>
            <span v-if="g.suspectCount" class="badge danger">⚠ {{ g.suspectCount }}</span>
          </div>

          <div class="srec-hd" aria-hidden="true">
            <span>科目</span><span>分数</span><span>附件</span><span class="srec-hd-ops">操作</span>
          </div>

          <div v-for="r in g.rows" :key="r.subject + '#' + r.scoreId" class="srec-row">
            <span class="srec-subject">{{ r.subject }}</span>
            <span class="srec-score">
              {{ r.score }}
              <span v-if="r.suspect" class="srec-flag" :title="`${r.score} 分超出常规 0–100，可能录入有误`">⚠</span>
            </span>
            <span class="srec-attach">{{ r.imageCount ? `🖼 ${r.imageCount} 张` : '—' }}</span>
            <span class="srec-ops">
              <button
                class="btn sm outline"
                :disabled="!r.scoreId"
                :title="r.scoreId ? '修改这条成绩' : '缺少行标识，请刷新页面'"
                @click="openEditor(g, r)"
              >✏️ 修改</button>
              <button
                class="btn sm srec-del"
                :disabled="!r.scoreId"
                :title="r.scoreId ? '删除这条成绩' : '缺少行标识，请刷新页面'"
                @click="askDelete(g, r)"
              >删除</button>
            </span>
          </div>
        </section>
      </div>

      <p v-if="status" class="msg" :class="statusType">{{ status }}</p>
    </template>

    <!-- 修改成绩弹窗 -->
    <div v-if="editing" class="srec-overlay" @click.self="closeEditor">
      <div class="srec-modal" role="dialog" aria-modal="true" aria-labelledby="srec-modal-title">
        <div class="srec-modal-head">
          <h3 id="srec-modal-title">修改成绩</h3>
          <button class="srec-close" aria-label="关闭" @click="closeEditor">✕</button>
        </div>

        <div class="srec-modal-body">
          <p class="srec-origin">
            当前记录：<strong>{{ origin.exam }}</strong> · {{ origin.subject }} {{ origin.score }} 分
          </p>

          <div class="srec-field">
            <label for="srec-f-exam">考试名称</label>
            <input id="srec-f-exam" v-model="form.exam_name" class="input" list="srec-exam-list" maxlength="40" />
            <datalist id="srec-exam-list">
              <option v-for="n in examNames" :key="n" :value="n" />
            </datalist>
          </div>
          <p v-if="isNewExamName" class="srec-tip">
            「{{ form.exam_name.trim() }}」是新的考试名称，保存后成绩趋势里会多出这一场考试。
          </p>

          <div class="srec-field">
            <label for="srec-f-subject">科目</label>
            <select id="srec-f-subject" v-model="form.subject" class="select">
              <option v-for="s in subjectOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>

          <div class="srec-field">
            <label for="srec-f-score">分数</label>
            <input id="srec-f-score" v-model="form.score" class="input" type="number" step="0.5" min="0" inputmode="decimal" />
          </div>
          <p v-if="scoreOutOfRange" class="srec-tip warn">
            常规百分制是 0–100，{{ form.score }} 分超出该范围。确实是 150 分制或特殊计分可以忽略这句。
          </p>

          <div class="srec-field srec-field-top">
            <label>附件</label>
            <div class="srec-attach-box">
              <div v-if="form.images.length" class="srec-thumbs">
                <div v-for="(img, i) in form.images" :key="i" class="srec-thumb">
                  <img :src="img" alt="成绩附件" />
                  <button class="srec-thumb-remove" :aria-label="`移除第 ${i + 1} 张附件`" @click="removeImage(i)">✕</button>
                </div>
              </div>
              <div class="srec-attach-actions">
                <label class="srec-file">
                  <input type="file" accept="image/*" capture="environment" multiple style="display:none" @change="onPickImages" />
                  <span class="btn outline btn-sm">📷 选择图片</span>
                </label>
                <span class="srec-attach-count">{{ form.images.length }}/{{ MAX_IMAGES }}</span>
                <button v-if="form.images.length" class="srec-link" @click="clearImages">清空附件</button>
              </div>
              <p class="srec-attach-hint">图片会自动压缩；已有附件不动时不会重新上传。</p>
            </div>
          </div>

          <p v-if="msg" class="msg" :class="msgType">{{ msg }}</p>
        </div>

        <div class="srec-modal-foot">
          <button class="srec-link danger" :disabled="saving" @click="askDeleteFromEditor">删除这条记录</button>
          <span class="spacer"></span>
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn primary" :disabled="saving" @click="doSave">{{ saving ? '保存中…' : '保存修改' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { updateScore, deleteScore } from '../api/student.js'
import { groupScoreRecords, examNameOptions, scoreEditState, PLAUSIBLE_MIN, PLAUSIBLE_MAX } from '../utils/scoreRecords.js'
import { collectImages, MAX_IMAGES } from '../utils/imageCompress.js'

const props = defineProps({
  // GET /student/:id 返回的 scores（按考试分组，含 _ids / _images）
  scores: { type: Array, default: () => [] },
  studentId: { type: [String, Number], required: true },
  // 科目库（后端 /subjects），修改时的候选
  subjects: { type: Array, default: () => [] }
})
const emit = defineEmits(['changed'])

const flat = computed(() => groupScoreRecords(props.scores))
const examNames = computed(() => examNameOptions(props.scores))

// —— 操作结果就地回执：改完成功的那句话出现在记录列表下方（记录所在的地方），
//    而不是飘在页面另一头。几秒后自动消失，不留常驻噪音。
const status = ref('')
const statusType = ref('ok')
let statusTimer = null
function flash(text, type = 'ok') {
  status.value = text
  statusType.value = type
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => { status.value = '' }, 5000)
}

// ================= 修改 =================
const editing = ref(false)
const saving = ref(false)
const msg = ref('')
const msgType = ref('ok')
const origin = ref({ scoreId: null, exam: '', subject: '', score: '' })
const form = ref({ exam_name: '', subject: '', score: '', images: [] })
let imagesTouched = false

const subjectOptions = computed(() => {
  const list = Array.isArray(props.subjects) ? props.subjects.slice() : []
  // 已有的科目可能不在科目库里（历史数据/批量导入带进来的），
  // 不能让它在下拉框里凭空消失 —— 一保存就变成改了科目。
  if (form.value.subject && !list.includes(form.value.subject)) list.unshift(form.value.subject)
  return list
})

const isNewExamName = computed(() => {
  const n = String(form.value.exam_name || '').trim()
  return !!n && !examNames.value.includes(n)
})

const scoreOutOfRange = computed(() => {
  const n = Number(form.value.score)
  if (!Number.isFinite(n) || form.value.score === '') return false
  return n < PLAUSIBLE_MIN || n > PLAUSIBLE_MAX
})

function openEditor(group, row) {
  if (!row?.scoreId) return
  // 表单初值由 scoreEditState 统一构造（那里有测试钉住 scoreId 必须带上）。
  // origin 记的是「改的是哪一条」——表格里显示的分数会被表单改掉，不能拿它当身份。
  const st = scoreEditState(group, row)
  origin.value = { scoreId: st.scoreId, exam: st.exam_name, subject: st.subject, score: st.score }
  form.value = { exam_name: st.exam_name, subject: st.subject, score: st.score, images: st.images }
  imagesTouched = false
  msg.value = ''
  editing.value = true
}

function closeEditor() {
  if (saving.value) return
  editing.value = false
  msg.value = ''
}

async function onPickImages(e) {
  const room = MAX_IMAGES - form.value.images.length
  if (room <= 0) {
    msg.value = `最多 ${MAX_IMAGES} 张附件`
    msgType.value = 'err'
    e.target.value = ''
    return
  }
  const { added, errors } = await collectImages(e.target.files, room)
  if (added.length) {
    form.value.images.push(...added.map(a => a.src))
    imagesTouched = true
  }
  if (errors.length) { msg.value = errors.join('；'); msgType.value = 'err' }
  else if (added.length) { msg.value = `已附加 ${added.length} 张`; msgType.value = 'ok' }
  e.target.value = ''
}

function removeImage(i) {
  form.value.images.splice(i, 1)
  imagesTouched = true
  msg.value = ''
}

function clearImages() {
  form.value.images = []
  imagesTouched = true
  msg.value = ''
}

async function doSave() {
  const exam = String(form.value.exam_name || '').trim()
  const subject = String(form.value.subject || '').trim()
  if (!exam) { msg.value = '考试名称不能为空'; msgType.value = 'err'; return }
  if (!subject) { msg.value = '科目不能为空'; msgType.value = 'err'; return }
  if (form.value.score === '' || !Number.isFinite(Number(form.value.score))) {
    msg.value = '分数必须是数字'; msgType.value = 'err'; return
  }

  const payload = { exam_name: exam, subject, score: Number(form.value.score) }
  // 附件没动就不提交 —— 附图很大，白白重传既慢又没必要
  if (imagesTouched) payload.images = form.value.images

  saving.value = true
  msg.value = ''
  try {
    const r = await updateScore(props.studentId, origin.value.scoreId, payload)
    if (r?.success) {
      editing.value = false
      flash(`已保存：${exam} · ${subject} ${payload.score} 分`)
      emit('changed')
    } else {
      msg.value = r?.error || '保存失败'
      msgType.value = 'err'
    }
  } catch (e) {
    // 后端对「改成已存在的科目/考试」返回 409 并带可读原因，这里原样展示，
    // 不要把「已有同名记录」这种可修正的冲突说成「保存失败」。
    msg.value = e.message
    msgType.value = 'err'
  } finally {
    saving.value = false
  }
}

// ================= 删除 =================
async function doDelete(scoreId, label, imageCount) {
  const extra = imageCount ? `同时会删掉 ${imageCount} 张附件图片，` : ''
  if (!confirm(`确认删除「${label}」？\n${extra}删除后无法恢复。`)) return false
  try {
    const r = await deleteScore(props.studentId, scoreId)
    if (r?.success) {
      flash(`已删除：${label}`)
      emit('changed')
      return true
    }
    flash(r?.error || '删除失败', 'err')
  } catch (e) {
    flash(e.message, 'err')
  }
  return false
}

function askDelete(group, row) {
  doDelete(row.scoreId, `${group.exam} · ${row.subject} ${row.score} 分`, row.imageCount)
}

async function askDeleteFromEditor() {
  const row = flat.value.groups
    .find(g => g.exam === origin.value.exam)?.rows
    .find(r => r.scoreId === origin.value.scoreId)
  const ok = await doDelete(
    origin.value.scoreId,
    `${origin.value.exam} · ${origin.value.subject} ${origin.value.score} 分`,
    row?.imageCount || 0
  )
  if (ok) editing.value = false
}

// 供父组件在「成绩详情弹窗」里就地唤起修改（点击图表上的点 → 看到某科 → 发现录错 → 直接改）
function openBySubject(examName, subject) {
  const g = flat.value.groups.find(x => x.exam === examName)
  const r = g?.rows.find(x => x.subject === subject)
  if (!g || !r || !r.scoreId) return false
  openEditor(g, r)
  return true
}
defineExpose({ openBySubject })

// ================= 键盘与清理 =================
function onKeydown(e) {
  if (e.key === 'Escape' && editing.value) closeEditor()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(statusTimer)
})
</script>

<style scoped>
/* ========== 卡片头 ========== */
.srec-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.srec-hint { font-size: 12px; color: var(--muted); font-weight: 400; }
.srec-empty { font-size: 13px; color: var(--muted); padding: 6px 0; }
.srec-warn {
  font-size: 12px; color: var(--warn); background: var(--warn-light);
  border-radius: var(--radius-sm); padding: 8px 12px; margin-bottom: 10px;
}

/* ========== 分组列表 ========== */
.srec-groups { display: flex; flex-direction: column; gap: 6px; }
.srec-group + .srec-group { margin-top: 6px; }
.srec-group-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 0 6px; }
.srec-exam { font-weight: 600; font-size: 14px; color: var(--primary-dark); }
.srec-group-meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.srec-hd,
.srec-row {
  display: grid;
  grid-template-columns: 84px 96px minmax(0, 1fr) max-content;
  align-items: center;
  gap: 12px;
}
.srec-hd {
  padding-bottom: 6px; border-bottom: 1px solid var(--line);
  font-size: 12px; color: var(--muted);
}
.srec-hd-ops { text-align: right; }

.srec-row { padding: 9px 0; border-bottom: 1px dashed var(--line); }
.srec-row:last-child { border-bottom: none; }
.srec-subject { font-size: 14px; font-weight: 500; }
.srec-score { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.srec-flag { margin-left: 4px; font-size: 12px; color: var(--danger); }
.srec-attach { font-size: 12px; color: var(--muted); }
.srec-ops { display: flex; gap: 6px; justify-content: flex-end; }

/* 删除按钮：表格里的破坏性操作，用「描边红」而不是实心红 ——
   实心红在每行都出现会把整页压得很吵，也容易误点。 */
.btn.srec-del {
  background: transparent; border-color: rgba(192, 57, 43, .35); color: var(--danger);
}
.btn.srec-del:hover:not(:disabled) { background: var(--danger-light); border-color: var(--danger); }
.srec-link {
  background: none; border: none; cursor: pointer; padding: 0;
  color: var(--accent); font-size: 12px; font-family: inherit;
}
.srec-link:hover { text-decoration: underline; }
.srec-link.danger { color: var(--danger); font-size: 13px; }
.srec-link:disabled { opacity: .5; cursor: not-allowed; }

/* 窄屏：一行拆两行，科目+分数在上，附件+操作在下 */
@media (max-width: 560px) {
  .srec-hd { display: none; }
  .srec-row { grid-template-columns: minmax(0, 1fr) max-content; gap: 6px 12px; padding: 10px 0; }
  .srec-subject { grid-column: 1; grid-row: 1; }
  .srec-score { grid-column: 2; grid-row: 1; text-align: right; }
  .srec-attach { grid-column: 1; grid-row: 2; }
  .srec-ops { grid-column: 2; grid-row: 2; }
}

/* ========== 弹窗 ========== */
.srec-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .45); z-index: 1100;
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.srec-modal {
  background: #fff; border-radius: var(--radius); width: 100%; max-width: 460px;
  box-shadow: var(--shadow-lg); display: flex; flex-direction: column; max-height: 90vh;
}
.srec-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--line);
}
.srec-modal-head h3 { margin: 0; font-size: 16px; }
.srec-close { background: none; border: none; cursor: pointer; font-size: 18px; color: var(--muted); padding: 0; }
.srec-modal-body { padding: 16px 20px; overflow-y: auto; }
.srec-modal-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 20px; border-top: 1px solid var(--line);
}

.srec-origin {
  font-size: 12px; color: var(--muted); background: var(--bg);
  border-radius: var(--radius-sm); padding: 8px 12px; margin-bottom: 14px;
}
.srec-origin strong { color: var(--text); }

.srec-field {
  display: grid; grid-template-columns: 76px minmax(0, 1fr);
  align-items: center; gap: 10px; margin-bottom: 12px;
}
.srec-field-top { align-items: start; }
.srec-field-top > label { padding-top: 8px; }
.srec-field > label { font-size: 13px; color: var(--text); }
.srec-field .input, .srec-field .select { width: 100%; }

.srec-tip { font-size: 12px; color: var(--muted); margin: -6px 0 12px 86px; }
.srec-tip.warn { color: var(--warn); }

.srec-attach-box { min-width: 0; }
.srec-thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.srec-thumb { position: relative; }
.srec-thumb img {
  width: 56px; height: 56px; object-fit: cover;
  border-radius: var(--radius-sm); border: 1px solid var(--line); display: block;
}
.srec-thumb-remove {
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px;
  border-radius: 50%; background: var(--danger); color: #fff; border: none;
  cursor: pointer; font-size: 10px; line-height: 18px; text-align: center; padding: 0;
}
.srec-attach-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.srec-file { cursor: pointer; }
.srec-attach-count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.srec-attach-hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
.btn-sm { padding: 5px 12px; font-size: 13px; }

.msg { padding: 10px 14px; border-radius: var(--radius-sm); margin-top: 12px; font-size: 13px; }
.msg.ok { background: var(--primary-light); color: var(--primary-dark); }
.msg.err { background: var(--danger-light); color: var(--danger); }
</style>
