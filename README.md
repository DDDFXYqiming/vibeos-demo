# VibeOS Demo

一个 Windows 原生可运行的"纯 LLM/Agent 运行时生成 UI"的软件形态。

> 这不是真正的操作系统，也不是微软项目源码。它是一个本地 Node.js + 浏览器桌面 shell：Windows 11 Fluent 风格界面、每个应用窗口一个 iframe、每个 iframe 一个独立 LLM session、用户点击/提交事件回传给后端，再由 LLM 生成下一版 HTML。应用状态由服务端 session 管理，LLM 通过结构化 JSON 维护每个应用的内部数据。

## 实现要点

```text
Windows / Node.js 本地服务
        ↓
Windows 11 Fluent 风格 Web Desktop Shell
        ↓
Window Manager：拖拽、缩放、最大化、关闭
        ↓
每个 App Window = sandboxed iframe
        ↓
iframe 捕获 click / submit / enter / change
        ↓
POST /api/sessions/:id/event
        ↓
LLM 生成下一版 HTML + 结构化 state
        ↓
替换 iframe srcdoc，state 写回 session
```

## 功能

- Windows 11 Fluent 风格桌面：顶部栏、底部居中 Dock、启动动画、窗口管理器。
- 每个应用独立 session：Browser、Terminal、Calculator、Files、Text Editor、Tasks、Settings、Vibe Prompt、About。
- iframe 事件桥：自动捕获按钮点击、表单提交、输入框 Enter、select/checkbox/radio/range 变化。
- LLM 后端：支持 OpenAI / OpenAI-compatible / Anthropic。
- 多级思考控制：`LLM_THINKING_LEVEL` 支持 off / low / medium / high / max。
- 安全边界：不执行本地命令；服务端会移除模型返回的 `<script>` 和 inline event handlers；iframe 使用 sandbox。
- Windows 原生：无 Docker、无 WSL、无数据库、无第三方 npm 依赖。

## 环境要求

- Windows 10/11
- Node.js 20+
- 浏览器：Chrome / Edge

检查 Node：

```powershell
node -v
```

## 服务管理

### 启动

```powershell
cd vibeos-demo
.\start.ps1
```

或 CMD：

```cmd
cd vibeos-demo
start.cmd
```

也可以直接用 Node 启动：

```powershell
cd vibeos-demo
node src/server.js
```

启动后打开：

```text
http://127.0.0.1:8765
```

首次启动会自动从 `.env.example` 复制 `.env`。

### 停止

```powershell
# 方法 1：在运行服务的终端按 Ctrl+C

# 方法 2：杀掉占用 8765 端口的进程
Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 方法 3：杀掉所有 Node 进程（慎用）
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 重启

最简单的方式：运行 `restart.ps1`（封装好了「停 → 等待 → 起」）。

```powershell
.\restart.ps1
```

或只杀进程：

```powershell
.\stop.ps1
```

再启动：

```powershell
.\start.ps1
```

如果你想手动一行命令完成，先停、再启动（注意下面的命令是**两行分别执行**，不要一次性整段粘贴到 PowerShell，避免空行或中文注释触发多行输入）：

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

```powershell
node src/server.js
```

## 配置 OpenAI / OpenAI-compatible

编辑 `.env`：

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
LLM_THINKING_LEVEL=off
```

> `LLM_THINKING_LEVEL`：控制模型思考深度等级。通用配置，同时适用于 OpenAI-compatible 和 Anthropic provider。
>
> | 等级 | 说明 | 适用场景 |
> |---|---|---|
> | `off`（默认） | 不启用思考模式，响应最快、token 最省 | 简单 UI、快速交互 |
> | `low` | 轻量思考，约 1024 tokens 预算 | 常规表单、列表操作 |
> | `medium` | 中等思考，约 4096 tokens 预算 | 复杂布局、数据可视化 |
> | `high` | 深度思考，约 8192 tokens 预算 | 多步骤交互、状态管理 |
> | `max` | 最大思考，约 16384 tokens 预算 | 最复杂的生成任务 |
>
> 思考等级越高，模型在生成 UI 前的推理越充分，但响应时间和 token 消耗也相应增加。

如果使用 OpenAI-compatible 服务，把 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 改成对应平台的值即可。

示例：

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=你的_key
OPENAI_BASE_URL=https://你的兼容端点/v1
OPENAI_MODEL=你的模型名
LLM_THINKING_LEVEL=off
```

## 配置 Anthropic

编辑 `.env`：

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
ANTHROPIC_BASE_URL=https://api.anthropic.com
LLM_THINKING_LEVEL=off
```

## 使用方式

- 点击左侧 Dock 打开应用。
- 点击顶部 `Activities` 查看应用网格。
- 在桌面输入框里描述一个应用，即可创建新应用。

配置真实 LLM 后，会生成一个临时应用窗口。每次点击/提交都会让同一个 session 继续生成下一版界面，应用状态在 session 内持续累积。

## 关键文件

```text
vibeos-demo/
  .env                   本地配置（不入库）
  .env.example           配置模板
  start.ps1              Windows PowerShell 启动脚本
  start.cmd              Windows CMD 启动脚本
  stop.ps1               杀掉占用 8765 端口的进程
  restart.ps1            stop + start 的组合脚本
  package.json           项目元数据，无第三方依赖
  src/server.js          Node.js HTTP 服务、LLM provider、session runtime、状态管理
  `src/logger.js`          高熵 NDJSON 日志系统（hrtime 精度，自动清理、日志轮转、查询 API）
  public/index.html      桌面 shell HTML
  `public/styles.css`      Windows 11 Fluent 风格桌面和窗口样式（浅色主题 + 深色模式支持）
  public/app.js          窗口管理器、iframe bridge、前端 runtime
```

## 日志

服务运行时会在 `logs/` 目录生成结构化 NDJSON 日志（`vibeos-YYYYMMDD.ndjson`），包含：

| 类别 | 说明 |
|---|---|
| `sys` | 服务启停、定时心跳、内存用量 |
| `http` | HTTP 请求耗时 |
| `llm` | LLM 调用耗时、token 估算、思考等级、错误 |
| `evt` | 前端事件类型、目标元素、session 匹配 |
| `sess` | Session 创建/销毁 |

日志自动清理 7 天前的旧文件。

## 安全说明

这个 demo 特意不实现真实 OS 能力：

- 不读取真实磁盘文件。
- 不执行 PowerShell、CMD、Bash 或系统命令。
- 不访问真实浏览器历史、Cookie、密码或系统凭据。
- Browser/Files/Terminal 等应用由 LLM 实时生成界面与交互逻辑。
- 应用状态保存在服务端 session 内存中，重启后丢失。

## API

### `GET /api/config`

返回当前 provider、model、ready 状态。

### `POST /api/sessions`

创建应用 session。

```json
{
  "appId": "custom",
  "title": "My App",
  "intent": "Create a kanban board"
}
```

### `POST /api/sessions/:id/event`

iframe 事件回传。前端会自动发送，通常不需要手写。

### `GET /api/health`

健康检查，返回服务状态和当前 session 数量。

## 常见问题

### 1. 启动之后无法交互？

检查模型配置 `.env`：

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=...
```

改完后重启服务。

### 2. OpenAI-compatible 返回格式异常？

本项目调用的是 `/chat/completions`，并要求 JSON object。确认你的兼容服务支持：

```text
POST /v1/chat/completions
response_format: { "type": "json_object" }
```

如果不支持，可以删除 `src/server.js` 里 OpenAI 请求体中的 `response_format`，模型仍会被 prompt 要求返回 JSON。

### 3. 为什么不让 LLM 执行本地命令？

因为这个 demo 的目标是复现"幻觉 UI runtime"，不是做 agent shell。执行本地命令会引入高风险权限边界问题。本项目除了 LLM 幻觉以外什么都没有。

## 局限

- 不是真正 OS、没有内核、没有驱动、没有真实文件系统。
- App 状态主要保存在内存 session，重启后丢失。
- LLM 返回质量取决于模型能力；小模型可能返回不稳定 JSON 或较粗糙 UI。
- 虽然有 sandbox 和 HTML 清洗，但不要把它部署到公网给不可信用户使用。

## License

MIT
