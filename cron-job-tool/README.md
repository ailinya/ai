# Cron Job Tool

基于 **NestJS + LangChain** 构建的 AI 驱动定时任务管理系统。用户通过自然语言与 AI 对话，AI 自动规划并创建定时/周期任务，任务到期后由后台 JobAgent 自主执行具体操作（发邮件、搜索网页、读写数据库等）。

---

## 目录

- [项目概览](#项目概览)
- [技术栈](#技术栈)
- [架构设计](#架构设计)
- [核心模块](#核心模块)
- [AI 工具说明](#ai-工具说明)
- [定时任务类型](#定时任务类型)
- [数据库实体](#数据库实体)
- [API 接口](#api-接口)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [目录结构](#目录结构)

---

## 项目概览

本项目实现了一个"自然语言驱动的自动化任务调度系统"：

1. 用户用自然语言描述任务需求（例如"1分钟后给我发一封笑话邮件"、"每天早8点查询数据库用户数并发邮件汇报"）
2. **前端 AI Agent**（`AiService`）理解意图，调用 `cron_job` 工具创建定时任务
3. **任务调度层**（`JobService`）将任务持久化到 MySQL，并在运行时注册到 `@nestjs/schedule`
4. **后台 Job Agent**（`JobAgentService`）在任务触发时接收自然语言指令，自主决策并调用相应工具执行

整个系统实现了"人说话 → AI 理解 → 自动调度 → 自动执行"的完整闭环。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 后端框架 | NestJS v11 + TypeScript |
| AI / LLM | LangChain (`@langchain/core`, `@langchain/openai`) |
| LLM 服务 | 阿里云 DashScope（通义千问 qwen-max，OpenAI 兼容接口） |
| 任务调度 | `@nestjs/schedule` + `cron` |
| 数据库 ORM | TypeORM + MySQL 2 |
| 邮件发送 | `@nestjs-modules/mailer` + Nodemailer (SMTP) |
| 网络搜索 | Bocha Web Search API |
| 参数校验 | Zod |
| 实时推流 | SSE（Server-Sent Events）|
| 静态文件 | `@nestjs/serve-static` |

---

## 架构设计

```
用户请求 (自然语言)
      │
      ▼
 AiController
 ┌──────────────────────────────────────────────┐
 │  GET  /ai/chat          → 普通响应            │
 │  GET  /ai/chat/stream   → SSE 流式响应        │
 └──────────────────────────────────────────────┘
      │
      ▼
 AiService (前端 AI Agent)
 ┌──────────────────────────────────────────────┐
 │  LLM + 工具绑定：                             │
 │  - query_user      查询内存用户               │
 │  - send_mail       发送邮件                   │
 │  - web_search      网页搜索                   │
 │  - db_users_crud   数据库 CRUD                │
 │  - time_now        获取当前时间               │
 │  - cron_job        管理定时任务               │
 └──────────────────────────────────────────────┘
      │ 创建任务时调用 cron_job 工具
      ▼
 CronJobToolService → JobService
 ┌──────────────────────────────────────────────┐
 │  持久化任务到 MySQL (Job 表)                  │
 │  注册到 SchedulerRegistry：                   │
 │  - type=cron  → addCronJob                    │
 │  - type=every → addInterval                   │
 │  - type=at    → addTimeout                    │
 └──────────────────────────────────────────────┘
      │ 任务触发时
      ▼
 JobAgentService (后台 Job Agent)
 ┌──────────────────────────────────────────────┐
 │  执行 instruction 自然语言指令                │
 │  LLM + 工具绑定：                             │
 │  - send_mail / web_search                     │
 │  - db_users_crud / time_now                   │
 └──────────────────────────────────────────────┘
```

### 双 Agent 设计说明

| Agent | 服务类 | 职责 |
|-------|--------|------|
| 前端 Agent | `AiService` | 理解用户请求，可直接执行或创建定时任务 |
| 后台 Agent | `JobAgentService` | 定时任务触发时，执行具体指令（不含 `cron_job` 工具，防止递归创建） |

---

## 核心模块

### AppModule

- 整合所有子模块
- 配置 TypeORM（MySQL）、MailerModule（SMTP）、ServeStaticModule、ScheduleModule
- 应用启动时可通过 `onApplicationBootstrap` 手动注册任务（当前为注释示例）

### AiModule

- 提供 `AiController` 和 `AiService`
- 注册 `QUERY_USER_TOOL`（内存用户查询工具）
- 导入 `UsersModule` 和 `ToolModule`

### ToolModule

统一管理所有 LangChain 工具的提供者，导出以下注入令牌：

| 注入令牌 | 服务类 | 功能 |
|----------|--------|------|
| `CHAT_MODEL` | `LlmService` | 获取 ChatOpenAI 模型实例 |
| `SEND_MAIL_TOOL` | `SendMailToolService` | 发送邮件 |
| `WEB_SEARCH_TOOL` | `WebSearchToolService` | Bocha 网页搜索 |
| `DB_USERS_CRUD_TOOL` | `DbUsersCrudToolService` | 用户表 CRUD |
| `TIME_NOW_TOOL` | `TimeNowToolService` | 获取服务器当前时间 |
| `CRON_JOB_TOOL` | `CronJobToolService` | 管理定时任务 |

### JobModule

- 提供 `JobService`，负责任务的数据库持久化和运行时调度
- 应用启动时 (`onApplicationBootstrap`) 从 MySQL 恢复所有 `isEnabled=true` 的任务

---

## AI 工具说明

### `query_user` — 查询内存用户

从 `UserService` 的内存列表中按 ID 查询用户信息（姓名、邮箱、角色）。

```
参数：userId (string)
返回：用户姓名、邮箱、角色
```

### `send_mail` — 发送邮件

通过配置的 SMTP 服务器发送电子邮件。

```
参数：to (email), subject (string), text? (string), html? (string)
返回：发送确认消息
```

### `web_search` — 网页搜索

调用 Bocha Web Search API 搜索互联网，返回标题、URL、摘要等信息。

```
参数：query (string), count? (1~20, 默认 10)
返回：搜索结果列表（标题/URL/摘要/发布时间）
```

### `db_users_crud` — 用户数据库 CRUD

对 MySQL `user` 表执行增删改查操作。

```
参数：action (create|list|get|update|delete), id?, name?, email?
返回：操作结果描述
```

### `time_now` — 获取当前时间

返回服务器当前时间的 ISO 字符串和毫秒级时间戳，AI 在计算"X分钟后"的绝对时间时依赖此工具。

```
参数：无
返回：{ iso: string, timestamp: number }
```

### `cron_job` — 管理定时任务

核心工具，支持三个操作：

| action | 说明 | 必填参数 |
|--------|------|---------|
| `list` | 列出所有任务及运行状态 | — |
| `add` | 新增定时任务 | `type`, `instruction`, 以及类型对应参数 |
| `toggle` | 启用/停用任务 | `id`，可选 `enabled` |

---

## 定时任务类型

| 类型 | 触发方式 | 关键参数 | 适用场景 |
|------|---------|---------|---------|
| `cron` | Cron 表达式，循环执行 | `cron`（如 `0 8 * * *`） | 每天早8点执行 |
| `every` | 固定毫秒间隔，循环执行 | `everyMs`（如 `60000`） | 每分钟轮询 |
| `at` | 到达指定时间点执行一次，执行后自动停用 | `at`（ISO 字符串） | 1分钟后提醒 |

### AI 任务类型选择规则（System Prompt 摘要）

- **"X分钟/小时后"、"在某个时间点"、"到点提醒"**（一次性）→ `type=at`
- **"每X分钟"、"定期循环"、"一直执行"**（重复）→ `type=every`
- **给出 Cron 表达式**（重复）→ `type=cron`

> `instruction` 字段只填"要做什么"，不包含时间信息，且必须是自然语言，不能是工具调用代码。

---

## 数据库实体

### User 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int (自增) | 主键 |
| `name` | varchar(50) | 用户姓名 |
| `email` | varchar(50) | 用户邮箱 |
| `createdAt` | timestamp | 创建时间 |
| `updatedAt` | timestamp | 更新时间 |

### Job 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `instruction` | text | 自然语言任务指令 |
| `type` | varchar(10) | 任务类型：`cron` / `every` / `at` |
| `cron` | varchar(100) | Cron 表达式（`type=cron` 时有值） |
| `everyMs` | int | 间隔毫秒（`type=every` 时有值） |
| `at` | timestamp | 触发时间点（`type=at` 时有值） |
| `isEnabled` | boolean | 是否启用 |
| `lastRun` | timestamp | 最后执行时间 |
| `createdAt` | timestamp | 创建时间 |
| `updatedAt` | timestamp | 更新时间 |

---

## API 接口

### `GET /ai/chat`

普通对话，返回完整 JSON 响应。

```
Query 参数：query (string) — 用户自然语言输入
响应：{ answer: string }
```

**示例：**
```
GET /ai/chat?query=1分钟后给我发一封笑话邮件到 xxx@qq.com
```

### `GET /ai/chat/stream`

SSE 流式对话，实时推送 AI 回答片段。

```
Query 参数：query (string)
响应：text/event-stream，每条 data 为一段文本片段
```

### 静态页面

| 路径 | 说明 |
|------|------|
| `/` | 项目主页（功能概览 + 快速跳转）|
| `/ai-sse-test.html` | AI SSE 流式聊天测试页面 |

---

## 快速开始

### 前置条件

- Node.js >= 18
- pnpm（或 npm/yarn）
- MySQL 8.0+（数据库名：`hello`，默认用户 `root`/`admin`）
- 阿里云 DashScope API Key
- QQ 邮箱 SMTP 授权码（或其他 SMTP 服务）

### 安装依赖

```bash
cd cron-job-tool
pnpm install
```

### 配置环境变量

复制并修改 `.env` 文件（见[环境变量配置](#环境变量配置)）：

```bash
cp .env.example .env   # 如有模板
# 或直接编辑 .env
```

### 创建数据库

```sql
CREATE DATABASE hello CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

> TypeORM 已开启 `synchronize: true`，启动后自动建表，无需手动执行 migration。

### 启动服务

```bash
# 开发模式（热重载）
pnpm start:dev

# 生产模式
pnpm build
pnpm start:prod
```

服务默认监听 `http://localhost:3000`。

### 测试

```bash
# 单元测试
pnpm test

# e2e 测试
pnpm test:e2e

# 覆盖率报告
pnpm test:cov
```

---

## 环境变量配置

在项目根目录的 `.env` 文件中配置以下变量：

```env
# ─── AI 模型（阿里云 DashScope / 通义千问）────────────────────────
MODEL_NAME=qwen-max
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# ─── 邮件服务（SMTP）────────────────────────────────────────────────
MAIL_HOST=smtp.qq.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=your-qq@qq.com
MAIL_PASS=your-smtp-authorization-code
MAIL_FROM=your-qq@qq.com

# ─── 网页搜索（可选）────────────────────────────────────────────────
BOCHA_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| 变量 | 说明 | 是否必填 |
|------|------|---------|
| `MODEL_NAME` | LLM 模型名称 | 必填 |
| `DASHSCOPE_API_KEY` | DashScope API Key | 必填 |
| `OPENAI_BASE_URL` | OpenAI 兼容接口基础 URL | 必填 |
| `MAIL_HOST` | SMTP 服务器地址 | 必填 |
| `MAIL_PORT` | SMTP 端口 | 必填 |
| `MAIL_SECURE` | 是否使用 SSL（`true`/`false`）| 必填 |
| `MAIL_USER` | SMTP 认证用户名 | 必填 |
| `MAIL_PASS` | SMTP 授权码 | 必填 |
| `MAIL_FROM` | 发件人地址 | 必填 |
| `BOCHA_API_KEY` | Bocha 网页搜索 API Key | 可选 |

---

## 目录结构

```
cron-job-tool/
├── public/
│   ├── index.html              # 项目主页
│   └── ai-sse-test.html        # SSE 聊天测试页面
├── src/
│   ├── ai/
│   │   ├── ai.controller.ts    # 对外 HTTP 接口（普通/SSE）
│   │   ├── ai.module.ts        # AI 模块（注册 QUERY_USER_TOOL）
│   │   ├── ai.service.ts       # 前端 AI Agent（runChain / runChainStream）
│   │   ├── job-agent.service.ts# 后台 Job Agent（执行任务指令）
│   │   └── user.service.ts     # 内存用户数据服务
│   ├── job/
│   │   ├── entities/
│   │   │   └── job.entity.ts   # Job 数据库实体
│   │   ├── job.module.ts       # Job 模块
│   │   └── job.service.ts      # 任务 CRUD + 运行时调度
│   ├── tool/
│   │   ├── tool.module.ts      # 工具模块（统一注册所有工具）
│   │   ├── llm.service.ts      # ChatOpenAI 模型工厂
│   │   ├── cron-job-tool.service.ts   # cron_job 工具
│   │   ├── send-mail-tool.service.ts  # send_mail 工具
│   │   ├── web-search-tool.service.ts # web_search 工具
│   │   ├── db-users-crud-tool.service.ts # db_users_crud 工具
│   │   └── time-now-tool.service.ts   # time_now 工具
│   ├── users/
│   │   ├── entities/
│   │   │   └── user.entity.ts  # User 数据库实体
│   │   ├── dto/                # DTO（CreateUser / UpdateUser）
│   │   ├── users.controller.ts # 用户 RESTful 接口
│   │   ├── users.module.ts
│   │   └── users.service.ts    # 用户 CRUD 业务逻辑
│   ├── app.controller.ts
│   ├── app.module.ts           # 根模块
│   ├── app.service.ts
│   └── main.ts                 # 应用入口
├── test/
│   ├── app.e2e-spec.ts
│   └── jest-e2e.json
├── .env                        # 环境变量（不提交到 git）
├── nest-cli.json
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

---

## 典型使用示例

### 一次性定时任务

```
用户：1分钟后给我的邮箱发一个今日天气预报
AI：好的，已为您创建定时任务 id=xxx，将在1分钟后执行"给我的邮箱发一个今日天气预报"。
```

后台流程：`AiService` → `cron_job(action=add, type=at, at=<now+1min>, instruction="给我的邮箱发一个今日天气预报")` → `JobService` 注册 setTimeout → 1分钟后 `JobAgentService` 调用 `web_search` 搜索天气，再调用 `send_mail` 发送邮件。

### 周期性任务

```
用户：每30秒查询一次数据库用户数量并打印日志
AI：已创建定时任务 id=xxx，每30秒（30000ms）执行一次"查询数据库用户数量并打印日志"。
```

### 使用 Cron 表达式

```
用户：用 cron 表达式 0 9 * * 1-5 设置工作日每天早上9点给我发邮件提醒开始工作
AI：已创建 Cron 任务 id=xxx，cron=0 9 * * 1-5。
```

---

## 注意事项

1. **`synchronize: true`** 仅适用于开发环境，生产环境请改用 TypeORM migration。
2. **`.env` 文件**包含敏感信息（API Key、邮箱密码），请确保已加入 `.gitignore`。
3. **`at` 类型任务**执行后会自动将 `isEnabled` 设为 `false`，不会重复触发。
4. **应用重启恢复**：`JobService.onApplicationBootstrap` 会自动从数据库恢复所有 `isEnabled=true` 的任务，无需担心重启丢失。
5. 前端 Agent 的 System Prompt 明确约束：创建定时任务时本轮**不执行**任务本身，只写入 `instruction`，由 JobAgent 在触发时执行。
