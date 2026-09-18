# 部署指南：GitHub + Cloudflare Pages

本项目是用 Vue3 + Vite + ECharts 构建的纯前端应用（后端为 Cloudflare Pages Functions + D1）。
下面把代码推到 GitHub，再用 Cloudflare Pages 连接仓库自动部署。

---

## ⚠️ 0. 最重要的一节：生产分支必须和 main 一致

**这是本项目最容易踩、且最难自查的坑。请看懂再往下。**

Cloudflare Pages 有一个「生产分支」（Production branch）设置，它决定**哪个 Git 分支的提交会部署到生产域名**
（本项目生产域名：`geixinghua.kdns.fr` / `pages.dev` 根域名）。

其他分支的提交只会生成 **Preview 预览部署**（一长串带 hash 的临时域名）。

**症状**：你在 GitHub 上明明看到代码更新了，Cloudflare 的部署列表里也有新记录，但**线上站点还是老样子**——
因为那条新记录标的是 `Preview` 而不是 `Production`。

**本项目当前的实际状态**（2026-09-16 排查确认）：

| 分支 | 用途 | 部署环境 |
|---|---|---|
| `main` | 日常开发主线 | 只产生 Preview |
| `production` | 生产 | **Production（线上就是这个）** |

所以每次改完代码，必须**同时推送两个分支**，否则线上不会更新：

```bash
git push origin main                 # 更新 main（触发预览部署）
git push origin main:production      # 把 production 追平 main（触发生产部署）
```

> `main:production` 的含义：把本地 `main` 推到远程的 `production` 分支。
> 只要 `production` 是 `main` 的祖先，这就是一次快进（fast-forward）推送，不会丢东西。

### 推荐：一劳永逸地改掉它

在 Cloudflare 控制台 → **Workers 和 Pages** → 选择项目 → **设置（Settings）** → **构建和部署（Builds & deployments）**
→ 找到 **生产分支（Production branch）** → 改成 `main` → 保存。

改完之后，以后只要 `git push origin main` 就会直接上线生产，不用再推两个分支。
（`production` 分支可以留着不用，也可以删掉。）

---

## 1. 推送到 GitHub

```bash
git branch -M main
git remote add origin https://github.com/<你的用户名>/student-growth-archive.git
git push -u origin main
```
> 若还没有 GitHub 仓库，先去 github.com 新建一个空仓库（不要勾 README），再用上面的命令关联。

## 2. Cloudflare Pages 连接部署

1. 登录 Cloudflare 控制台 → 左侧 **Workers 和 Pages** → **创建** → 选 **Pages** → **连接到 Git**
2. 授权并选择 `student-growth-archive` 仓库
3. 构建设置：
   - Framework preset：**Vite**（或自定义）
   - Build command：`npm run build`
   - Build output directory：`dist`
4. 点击 **保存并部署**
5. 约 1 分钟后得到 `https://<项目名>.pages.dev` 域名，即可访问

## 3. 后端与数据库（D1）

后端是单文件 catch-all：`functions/api/[[path]].js`，所有接口都在里面按 `path` + `method` 分发。

- **绑定**：项目 → 设置 → **函数（Functions）** → **D1 数据库绑定**，变量名必须是 `DB`。
- **会话 KV**：另需一个 KV 命名空间绑定，变量名 `SESSIONS`（用于登录态）。
- **建表**：`homework_assignments`、`homework_records` 两张表由后端
  `ensureHomeworkTables()` 在**首次调用作业接口时自动创建**，部署时无需手工执行 SQL。
  `schema/homework-detail.sql` 是同结构的归档版本，供手工/CI 初始化使用。
- **好消息**：新表是纯增量，**不影响已有数据**；自动建表失败时接口会降级（档案仍可正常读取）。

### ⚠️ 改数据库前必读：表结构以线上为准

本项目早期是**直接在 D1 控制台手工建表**的，建表语句一度只存在于线上。
这导致「代码假设的结构」与「线上真实结构」悄悄分叉，并且造成过一个线上必现、
本地全绿的 bug。现在线上真实结构已导出归档在 **`schema/baseline.sql`**，
本地测试一律以它建库。

其中最需要记住的一条：

> `homework.rate` 是 **STORED 生成列**，由数据库自己算：
> ```sql
> rate REAL GENERATED ALWAYS AS (
>   CASE WHEN total > 0 THEN (total - missed) * 1.0 / total ELSE 0 END
> ) STORED
> ```
> **生成列禁止写入。** 任何 `INSERT` / `UPDATE` 里带上 `rate` 都会报：
> `cannot UPDATE generated column "rate": SQLITE_ERROR [code: 7500]`
> 正确做法：只写 `total` / `missed`，改完再读回来取 `rate`。
> 代码已统一走 `writeHomeworkSummary()`（它会先探测表结构再决定写哪些列），
> 新增任何写汇总的代码请复用它，不要自己拼 SQL。

另一个容易踩的点：**`PRAGMA table_info` 不会列出生成列**。
所以判断「某列能不能写」时，要同时看列清单和 `sqlite_master` 里的建表语句
（`writeHomeworkSummary` 里就是这么做的）。

### 只想查线上数据/结构时（只读）

```bash
# 查看所有表的结构
npx wrangler d1 execute student-growth-archive --remote \
  --command "SELECT name, sql FROM sqlite_master WHERE type='table'"

# 查某张表的列（注意：生成列不会出现）
npx wrangler d1 execute student-growth-archive --remote \
  --command "PRAGMA table_info(homework)"
```


> ⚠️ 注意：Cloudflare Pages 允许给 **Preview 和 Production 绑定不同的 D1 数据库**。
> 如果你在预览环境录入了测试数据，切到生产看不到，多半是两边绑定了不同的库。
> 想让两边数据一致，把 Production 的 D1 绑定改成和 Preview 同一个即可。

## 4. 常见坑

- **改了代码线上没变** → 最常见原因是「生产分支」问题，见第 0 节。
- **构建报 node 版本错误**：在 CF Pages 项目 **设置 → 环境变量** 添加 `NODE_VERSION = 22`（生产环境），重新部署。
- **页面空白/刷新 404**：本项目用 hash 路由（`#/student/xxx`），CF Pages 静态托管无需额外配置即可刷新。
- **图表不显示**：确认 `dist/assets/` 下的 js/css 已随构建上传（正常部署都会带上）。
- **作业管理页报「表不存在」**：确认 D1 绑定变量名是 `DB`，再随便打开一次作业管理页触发自动建表。

## 5. 验证部署是否真的生效（不用等别人告诉你）

每次部署后，可以用构建产物的文件名核对线上到底跑的是哪一版：

```bash
# 1) 本地构建，记下入口文件名（形如 index-XXXXXXXX.js）
ls dist/assets/

# 2) 拉线上 HTML，看它引用的是哪个文件名
curl -s https://<你的域名>/ | grep -o 'assets/[A-Za-z0-9_.-]*\.js'
```

两边文件名一致 = 线上已是最新；不一致 = 部署还没完成，或者你推的分支不是生产分支。

### 想直接验证某个「需要登录」的接口（不改动任何真实数据）

写接口都在鉴权后面，浏览器里点不出来的时候可以自己造一个临时登录态：

```bash
# 1) 造一个临时会话（key 必须是 session:<token>，值就是会话 JSON）
#    注意：文件不能带 UTF-8 BOM，否则 JSON.parse 会失败、接口静默返回 401
printf '%s' '{"id":"A001","name":"管理员","role":"admin","className":"全部班级"}' > /tmp/sess.json
npx wrangler kv key put session:probe-abc123 --path /tmp/sess.json --namespace-id <SESSIONS 的 id>

# 2) 等 30~60 秒（KV 是最终一致，新 key 传到边缘需要时间），再调用接口
curl -X PUT https://<你的域名>/api/student/<学号>/homework \
  -H 'Authorization: Bearer probe-abc123' -H 'Content-Type: application/json' \
  -d '{"total":12,"missed":2}'

# 3) 用完立刻删掉临时会话，并按需还原数据
npx wrangler kv key delete session:probe-abc123 --namespace-id <SESSIONS 的 id>
```

`<SESSIONS 的 id>` 见 `wrangler.toml` 的 `[[kv_namespaces]]`。

## 6. 后续接真实数据（不改前端，只改一个文件）

打开 `src/api/student.js`：
- 把 `USE_WORKER = false` 改为 `true`
- 把 `WORKER_URL` 填成你的 CF 地址

## 7. 全局编辑模式（改前端「哪里能改」时的第一步）

全站只有一个编辑开关，在顶栏，由 `src/utils/editMode.js` 承载：

```
开启 → 成绩录入 / 行为评分 / 作业提交情况 / 作业管理 / 学生·教师·家长·邀请码管理
        所有编辑入口出现
关闭 → 以上入口全部收起，页面回到干净只读态（家长查看、投屏、打印都更清爽）
```

**改前端时请遵守这四条，否则会出现「开关关了还能改」的旁路：**

1. **任何新的写入入口都要挂 `v-if="canEdit"`**，不要用 `v-if="isStaff"`。
   `canEdit` 已经包含「教职工 + 开关已开」两层判断。
   ```js
   import { useEditMode } from '../utils/editMode.js'
   const { editMode, canEdit, toggleEditMode } = useEditMode()
   ```
2. **写入类弹窗的 `v-if` 也要带 `canEdit`**（纵深防御），并在 `watch(editMode)` 里把
   弹窗状态归零，避免残留一个还能点「保存」的窗。
3. **只读时必须在页面上留一个 `.readonly-hint` 提示条 + 开启出口**。
   历史上踩过的坑：编辑按钮被收起却没说原因，教师以为「系统不给编辑」。
4. **不要把普通状态直接读 `localStorage` 塞进 `computed`**。
   `localStorage` 不是响应式依赖，computed 首次求值后会永久缓存，开关点了没反应。
   编辑态用 `sessionStorage` 存（关掉标签页即回到只读，不跨会话残留写权限）。

学生 / 家长即使在开关打开时也永远只读 —— 这是前端双保险，后端另有 `requireTeacher` 兜底。

## 8. 跑测试

```bash
cd student-growth-archive
node tests/edit_mode_test.mjs        # 前端：全局编辑模式（61 项）
```

后端几套测试在仓库外的工作目录（因为 `functions/api/[[path]].js` 含方括号，
必须先复制成普通文件名才能 import）：

```bash
node run_all_tests.mjs               # 一次跑完全部套件并汇总
```

覆盖范围：作业结构 / 生成列写入 / 降级（42）、路由注册（28）、
角色 × 接口隔离矩阵（40）、作业接口（62）、全局编辑模式（61）。

`edit_mode_test.mjs` 里除了逻辑测试，还有一份**结构断言表**：把「受管辖的写法」
逐个列出来（例如 `v-if="canEdit" class="btn outline sm" @click="openHomeworkEdit"`）。
新增写入按钮却忘了挂 `canEdit` 时，对应条目会失配，测试立刻失败 —— 这是防旁路的第一道网。

## 9. ⚠️ 性能铁律：单次请求的 SQL 条数必须与数据量无关

线上出现过「学生列表整个空了、什么都点不了，报 请求失败: 503」。
根因不是数据坏了，而是列表接口里有 N+1：

```
dbGetStudents 原本是「先查学生，再对每个学生各查一条成绩、一条作业汇总」
81 名学生 = 1 + 2×81 = 163 条串行 SQL，单请求 2.3 秒；
并发 25 个请求时单请求涨到 14 秒，直接撞上 Cloudflare 免费版的 CPU 上限，
边缘返回 503，页面上的表现就是「列表空白 + 什么都点不了」。
```

区分办法：看 Cloudflare 返回的**响应体**。自己代码报的错一定是 JSON（含 `error` 字段）；
平台掐断返回的是 HTML 错误页，标题长这样：

```html
<title>Worker exceeded resource limits | 你的域名 | Cloudflare</title>
```

前端 `fetchJSON` 在这种情况下拿不到 `error` 字段，于是显示成「请求失败: 503」——
看到这句基本可以直接判定是平台层超限，不要再往业务逻辑里找。

### 规矩

1. **列表类接口的 SQL 条数必须是常数**，不能随行数增长。
   按 id 批量取附属数据用 `WHERE x IN (...)` 一次查回来；
   需要「每人取前 N 条」用窗口函数（`ROW_NUMBER() OVER (PARTITION BY ...)`）。
2. **`IN (...)` 必须分片**：D1 单条 SQL 的绑定参数上限是 100，
   超过直接报 `too many SQL variables`。项目里统一用 `chunksOf()`（默认 90 一片）。
3. **批量写/删走 `env.DB.batch()`**（一组语句一个事务、只占一次往返），
   或多行 `VALUES`。逐条 `await` 的循环在几十条数据时就开始出问题。
   参考实现：`purgeStudents()`（删学生）、`handleImportStudents()`（导入）、
   `recomputeHomeworkForStudents()`（回写汇总）。
4. **新增任何写入入口都要问一句：这条路径在 500 条数据时会发多少条 SQL？**

### 怎么防复发

这类缺陷有个特点：**返回的数据完全正确**，所以任何「比对返回值」的测试都抓不到它。
必须直接断言 SQL 条数 —— 测试基座（`test-harness.mjs`）的 `makeTestEnv()` 返回
`stats`，会统计 `roundTrips`（往返次数）与 `statements`（语句条数）。
见 `api_scale_test.mjs`：同一接口在 3 人与 60 人下测出的 SQL 条数必须相等。

## 10. ⚠️ 「全部班级」是筛选保留名，不是班级

`全部班级` 是下拉框里「不筛选」的哨兵值，代码里到处用它表示「查全部」。
它**绝不能被写进 `users.class_name`**。线上出过一次：

```
用管理员账号批量导入学生
  → 管理员自己的 class_name 恰好是「全部班级」
  → 而当时的导入写死了 className = teacher.className
  → 48 名学生全部被打上「全部班级」
  → 这批学生既筛不出来（选「全部班级」等于不筛选，会返回全校），
    又污染按班级过滤的所有视图，事后只能人肉清理。
```

现在的防线有三层：

- **写入口拒绝**：`handleCreateStudent` / `handleUpdateStudent` / `handleImportStudents`
  统一走 `isRealClassName()`，哨兵值与空值直接 400 并说明原因。
- **导入尊重 CSV**：班级以 CSV 的班级列为准，缺失才回落到导入者的班级。
- **界面先预览**：导入前弹预览，逐行标出「可导入 / 有问题 / 已存在」，
  确认后才提交（`src/utils/studentImport.js` 是纯函数，有单测）。

历史脏数据怎么收拾：

- 少量：在「学生管理」点「编辑」把班级改对（成绩、作业记录都能保住）。
- 成批：勾选 + 「批量删除」（一次请求清一批，不会因为逐条删而卡死）。
- 班级下拉框里的乱码名：POST `/api/admin/fix-classnames`（管理员），
  它会清掉 `classrooms` 里编码损坏与哨兵行，并列出班级为哨兵值的学生。

## 11. wrangler 排查线上时的四个坑（都实际踩过）

1. **`kv key` 系列命令默认操作本地存储**，必须显式加 `--remote`。
   不加的话 put 会「成功」，但它写的是本地目录，线上读不到，
   排查时表现为「会话造好了却一直 401」。
2. **`d1 execute --file` 走的是批量导入通道**，只返回汇总
   （`Total queries executed` / `Rows read`），**拿不到结果集**。查数据要用 `--command`。
3. **不要用 `spawn(npx, [...], { shell: true })` 传 SQL**：
   Windows 上参数会被拼成字符串交给 cmd.exe，SQL 里的 `*` `(` `)` `'` 被拆开，
   `--command` 收不到值（报 `[string] [required]`）。
   直接 spawn `node <path>/wrangler/bin/wrangler.js` 且 `shell: false`，argv 逐字传递。
4. **PowerShell 控制台按 GBK 解码子进程输出**，结果里的中文会变成乱码
   （`全部班级` → `鍏ㄩ儴鐝骇`），看起来像数据坏了，其实只是显示问题。
   要么把 stdout 当 Buffer 收（Node 里做），要么在 SQL 里用 `hex(列名)` 取值、
   用 `char(0x5168,0x90E8,0x73ED,0x7EA7)` 拼中文字面量。

---

## 12. ⚠️ 部署分支已变更（2026-09-16 实测，与本节冲突的以本节为准）

Cloudflare Pages 的「生产分支」已经从 `production` 改成了 **`main`**。
要看部署列表的 **Environment 列**才知道真相，不要只看分支名：

```bash
node <wrangler.js> pages deployment list --project-name student-growth-archive
# Environment | Branch     | Source
# Production  | main       | d89f9a2   <- 推 main 就上线
# Preview     | production | d89f9a2   <- 推 production 只产生预览，不影响线上
```

所以现在：

```bash
git push origin main        # 只需这一行
```

`production` 分支已退化为普通分支，推它只产生 Preview。
本文档前面「每次发布必须推两个分支」的说法在 2026-09-16 16:00 之前是对的，之后不再需要。

### 只改后端时怎么验证是否上线

`functions/api/[[path]].js` 的改动**不会改变静态资源指纹**（Pages Functions 与静态资源分开部署），
所以「资源文件名与本地一致」证明不了后端已更新。改用「新接口 / 新字段」验证，例如调用
`POST /admin/fix-classnames`，响应里应出现新加的 `mergedRoomCount` 字段。

### 推送卡死时：是凭据管理器在等交互，不是网络

现象：`git push` 长时间无输出挂住，但 `git ls-remote` 秒回。
（fetch 只需匿名 GET，push 要鉴权的 `git-receive-pack`，这个不对称就是线索。）
`GIT_TRACE=1 GIT_CURL_VERBOSE=1` 里能看到 401 之后调用 `git credential-manager get`，
无界面环境下它会永远等下去；`GIT_TERMINAL_PROMPT=0` 拦不住它。绕过办法：

```bash
git -c credential.helper= -c credential.helper=store push origin main
```

（第一个空值清空 helper 列表，第二个只留 `store`，凭据取自 `~/.git-credentials`。）
另注：push 成功后**输出可能是空的**，不要据此判断失败，一律用
`git ls-remote origin refs/heads/main` 核对 SHA。

---

## 13. 部署到另一个 Cloudflare 账号（fork 之后必读）

上面的步骤假设你用的是**原来那个账号**。如果你 fork 了仓库、要部署到**另一个 CF 账号**，
有三条硬约束必须先知道，否则一定卡住：

### 13.1 三个"不换就不行"的点

1. **`wrangler.toml` 里的两个资源 ID 是账号级的，不能复用。**
   `database_id` 和 KV 的 `id` 都属于原账号，新账号里不存在。必须新建后替换。
   漏做这步的表现是**构建全绿、只在部署最后一步失败**：

   ```
   Error: Failed to publish your Function. Got error:
   KV namespace '64846c6738274df3988cae507eed035d' not found.
   Verify the namespace exists in your account and that the namespace_id
   in your configuration is correct.
   ```

   注意 `wrangler.toml` 里声明的绑定**优先级高于控制台**：在 Pages 控制台里
   手动配一遍绑定绕不过它，必须改这个文件（或者把这两个绑定块从文件里删掉、
   完全交给控制台 —— 那样 fork 以后 `git pull` 上游不会冲突，代价是配置不在代码里）。
2. **新库是空的，而且没有"首个用户自动成为管理员"的逻辑。**
   `POST /auth/register` 必须带邀请码，而 `POST /admin/invite-codes` 只有管理员能调 ——
   全新库 → 无管理员 → 发不出邀请码 → 一个账号都注册不了。
   **必须手工往新库插一条管理员**，见 13.3。
3. **密码存的是 SHA-256 哈希（无盐）**，不是明文。自己造账号要先算哈希。

> 好消息：前端 API 基址是相对路径 `/api`（同源），
> **换域名不需要改任何前端代码**。

### 13.2 建库、建表

```bash
npx wrangler logout && npx wrangler login && npx wrangler whoami   # 先确认登录的是新账号

npx wrangler d1 create student-growth-archive        # 拿到 database_id
npx wrangler kv namespace create SESSIONS            # 拿到 KV id

# 把两个 ID 填进 wrangler.toml（binding 名 DB / SESSIONS 一个字都不能改）

npx wrangler d1 execute student-growth-archive --remote --file=schema/baseline.sql -y
```

⚠️ `--remote` 必须加，否则 SQL 只写进本地模拟库，线上会一直报"表不存在"。
`baseline.sql` 含 11 张表 + 2 个索引，建完不需要再做别的。

### 13.3 造初始管理员（跳过这步就登不进去）

```bash
# 1) 算密码哈希（用 node，不要用会带换行符的 echo）
node -e "console.log(require('crypto').createHash('sha256').update('你的密码').digest('hex'))"

# 2) 插库
npx wrangler d1 execute student-growth-archive --remote -y \
  --command "INSERT INTO users (id, account, password_hash, role, name, class_name, status, must_change_pwd, created_by) VALUES ('A001','admin','<上一步的哈希>','admin','管理员',NULL,'active',0,'bootstrap')"
```

⚠️ **`class_name` 写 `NULL`，不要写「全部班级」** —— 那是界面筛选的哨兵值，
不是班级名（见第 10 节，历史事故的起因）。管理员本来就不受班级限制，写 NULL 最干净。

### 13.4 Pages 侧要配的东西

| 位置 | 配置 |
|---|---|
| 构建配置 | 构建命令 `npm run build`；输出目录 `dist`；框架预设 Vite |
| 生产分支 | 必须与你实际推送的分支一致（新项目默认 `main`） |
| 设置 → 函数 → 绑定 | D1 变量名 **`DB`**、KV 变量名 **`SESSIONS`** |
| 设置 → 环境变量 | `NODE_VERSION=22`（Production 和 Preview 都加） |
| 设置 → 环境变量 | （可选）`AGNES_API_KEY` / `AGNES_BASE_URL` / `AGNES_MODEL`，加密变量 |

⚠️ **绑定和环境变量是"部署时注入"的，改完必须重新部署一次**，光保存设置不生效。
但"重新部署"有两种，**用错等于没做**：

- **只改了控制台设置**（绑定 / 环境变量）→ Deployments → ⋯ → **重试部署**，重放本次部署并带上新绑定。
- **改了仓库里的代码或 `wrangler.toml`** → 重试部署**没有用**：Retry 重放的是**同一个 commit**，
  不会去拉最新代码（表现就是"我明明改了、部署日志里却还是旧提交"）。
  必须推一个新提交：`git commit --allow-empty -m "redeploy" && git push`。

想确认某次部署到底跑的哪份代码：看 Deployments 那条记录的 commit，
与 `git rev-parse HEAD` 对一下 —— 对不上就是重放了旧提交。

### 13.5 搬数据（可选）

```bash
# 【老账号】导出（只导数据）
npx wrangler d1 export student-growth-archive --remote --no-schema --output=old-data.sql
# 【新账号】登录后导入
npx wrangler d1 execute student-growth-archive --remote --file=old-data.sql -y
```

⚠️ 导出文件含全站 `password_hash`，别提交进仓库、别外传，用完删掉。
⚠️ `--no-schema` 很重要，表结构用 13.2 那份 `baseline.sql` 建，别让导出文件覆盖。
⚠️ 迁移来的账号可能残留 `class_name = '全部班级'`，用管理员调一次
`POST /api/admin/fix-classnames` 清理。

### 13.6 验收

- `whoami` 是新账号 → `wrangler.toml` 两个 ID 已换 → 建表返回 11 张表 → `users` 里能看到管理员
- 部署列表最新一条是 **Production**；绑定里 `DB` / `SESSIONS` 都在，且**已重新部署过**
- 打开站点能登录（证明 D1 读 + KV 写通）；能新增一名学生（证明 D1 写通）
- 发一个邀请码 → 用**无痕窗口**走一次注册（证明注册链路通）

详细版操作手册（含逐步命令、截图级说明、常见报错速查表）见工作区文档
`部署到新CF账号-操作手册.html`。
