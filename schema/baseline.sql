-- ============================================================
-- 生产环境 D1 真实表结构（baseline）
-- ------------------------------------------------------------
-- 用途：
--   1. 结构归档 —— 本项目早期是直接在 Cloudflare D1 控制台手工建表的，
--      建表语句一度只存在于线上，代码里没有任何地方记录，导致
--      「代码假设的结构」与「线上真实结构」悄悄分叉。
--   2. 作为测试基准 —— 本地测试必须用这份 DDL 建库，
--      否则测试通过不代表线上可用。
--
-- 这份文件由以下命令从线上导出（只读查询）：
--   wrangler d1 execute student-growth-archive --remote \
--     --command "SELECT name, sql FROM sqlite_master WHERE type='table'"
--
-- ⚠️ 血泪教训（务必不要"简化"这段结构）：
--   homework.rate 是 STORED 生成列，由数据库计算。
--   任何 INSERT / UPDATE 写入 rate 都会直接报错：
--     cannot UPDATE generated column "rate": SQLITE_ERROR [code: 7500]
--   （曾导致教师保存作业提交率时前端只看到"请求失败: 500"）
--   另一个坑：PRAGMA table_info 不会列出生成列，因此
--   「列清单里有 rate / 建表语句里有 rate」两个信号必须一起看。
-- ============================================================

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account TEXT UNIQUE NOT NULL,       -- 登录账号（工号/学号/手机号）
  password_hash TEXT NOT NULL,        -- SHA-256 哈希（非明文）
  role TEXT NOT NULL DEFAULT 'student', -- teacher / student / admin / parent
  name TEXT NOT NULL,                 -- 姓名
  class_name TEXT,                    -- 班级
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active',
  must_change_pwd INTEGER DEFAULT 0,
  created_by TEXT,
  email TEXT
);

-- ---------- 成绩 ----------
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  exam_name TEXT NOT NULL,            -- 考试名称（开学考/月考1...）
  subject TEXT NOT NULL,              -- 科目
  score INTEGER NOT NULL,             -- 分数
  created_at TEXT DEFAULT (datetime('now')),
  images TEXT DEFAULT '[]',
  FOREIGN KEY (student_id) REFERENCES users(id),
  UNIQUE(student_id, exam_name, subject)
);

-- ---------- 作业提交汇总（一人一行）----------
-- rate 是 STORED 生成列：写入被禁止，读取正常。
CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  missed INTEGER NOT NULL DEFAULT 0,
  rate REAL GENERATED ALWAYS AS (
    CASE WHEN total > 0 THEN (total - missed) * 1.0 / total ELSE 0 END
  ) STORED,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

-- ---------- 课堂行为 ----------
CREATE TABLE IF NOT EXISTS behavior (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  raise_hand REAL DEFAULT 0,          -- 举手积极性
  focus REAL DEFAULT 0,               -- 专注度
  cooperation REAL DEFAULT 0,         -- 合作度
  homework_quality REAL DEFAULT 0,    -- 作业质量
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

-- ---------- 成长事件 ----------
-- images 是后加的列（2026-10 起的「成长时间线配图」）。
-- 已经在跑的库不会因为改这个文件而自动多出这一列 —— 后端在第一次读写事件时
-- 会惰性执行 ALTER TABLE events ADD COLUMN images（见 ensureEventImages）。
-- 新建库（含 D1 控制台跑本文件）直接就有，无需额外操作。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,           -- 奖励/活动/提醒
  content TEXT NOT NULL,
  images TEXT DEFAULT '[]',           -- 图片附件：base64 dataURL 的 JSON 数组，最多 3 张
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

-- ---------- AI 报告 ----------
CREATE TABLE IF NOT EXISTS ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  report_json TEXT NOT NULL,          -- 完整 AI 报告 JSON
  generated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

-- ---------- 班级 ----------
CREATE TABLE IF NOT EXISTS classrooms (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- 邀请码 ----------
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher',
  class_name TEXT,
  created_by TEXT,
  used INTEGER DEFAULT 0,
  used_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  used_at TEXT
);

-- ---------- 家长绑定 ----------
CREATE TABLE IF NOT EXISTS parent_links (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(parent_id, student_id)
);

-- ============================================================
-- 以下两张表由后端 ensureHomeworkTables() 在首次使用时自动创建
-- （建表语句同时保存在 functions/api/[[path]].js 的 HOMEWORK_DDL）
-- ============================================================

-- 一次作业（班级/科目/标题/日期 四者唯一 → 重复导入幂等）
CREATE TABLE IF NOT EXISTS homework_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 一人一次提交状态：submitted 已交 / late 补交 / missing 未交 / exempt 免交 / pending 待标记
CREATE TABLE IF NOT EXISTS homework_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_asg_uniq ON homework_assignments (class_name, subject, title, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_rec_uniq ON homework_records (assignment_id, student_id);
CREATE INDEX IF NOT EXISTS idx_hw_rec_student ON homework_records (student_id);
CREATE INDEX IF NOT EXISTS idx_hw_asg_class ON homework_assignments (class_name, due_date);
