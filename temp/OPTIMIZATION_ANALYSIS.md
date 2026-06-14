# VibeOS Demo — 纯代码技术层面优化分析

> **范围**：本报告只讨论"纯代码技术层面"的优化点（性能 / 健壮性 / 可维护性 / 资源占用 / 测试覆盖），不动产品方向、不改 API 行为契约。
>
> **基准**：本地 `E:\AI_Projects\vibeos-demo`，已 fast-forward 至远端最新 `3ace54d`（含最新 patch-failure 反馈链路）。
>
> **方法**：`codegraph` 全量索引 → 逐文件 read + node → 交叉对照测试 → 按"高/中/低"影响度与"小/中/大"改造量整理。
> 报告末尾附"建议执行顺序"。

---

## 0. TL;DR

项目整体写得相当克制：零第三方依赖、纯 Node 内置 HTTP、单文件 server.js（≈ 700 行）、沙箱化 iframe、强 LLM 解析容错、增量 patch + 失败回退链路、纯文本 NDJSON 日志。这套架构在 demo 阶段非常合适。

**真正可挖的优化点集中在五处**（按性价比排序）：

1. **logger.js 同步 `fs.appendFileSync` 在 LLM 主路径上** — 每次 HTTP 响应都触发一次同步 I/O，是隐藏的吞吐瓶颈。
2. **LLM provider 缺乏重试 / 退避 / 限流 / 状态码细分** — 任何网络抖动、5xx 或限流都会让用户看到红屏。
3. **`generateNextHtml` 里的消息裁剪算法** — 现在的 `while/splice` 写法不是「每轮最多裁掉 2 条」，是「只要超长就反复 splice」，会引入 O(n²) 退化；且隐式耦合 system/initial-intent 的位置。
4. **`extractStructureOutline` 用 regex 手写 HTML 解析** — 遇到畸变 HTML（LLM 最爱产出）易产生 stack 错位，提示给模型后让下一轮更糟。
5. **`applyPatch` 与 `postMessage` 的回退路径不一致** — 已用 `data-vibe-action` 标 recovery，但 patch 失败时仍会整体替换 `html`，破坏视觉连续性。

其余都是可读性、测试覆盖、模块边界这些"小修小补"。

---

## 1. 性能 / I/O

### 1.1 [中影响 / 小改造] logger `appendFileSync` 应改为异步或缓冲
**位置**：`src/logger.js:36-49`（`write` → `fs.appendFileSync`）

**现状**：每次 `info/perf/warn/err` 都同步打开 + 追加 + 关闭文件。一次 LLM 调用至少产生 3-4 条日志（timer.start 不打、timer.stop 一次、可能还有 warn），意味着每张 LLM 响应要付 3-4 次同步 I/O 的代价。

**风险**：
- 跨磁盘时（HDD / 网盘）单次 `appendFileSync` 可达 5-30ms，把 P99 直接打高。
- 同步调用会阻塞 Event Loop 整个 tick，间接影响所有并发 HTTP 处理（即使你用单进程顺序处理，整个 server 的响应延迟都被拉高）。

**建议**：
- 引入 "当日文件句柄缓存" + `write` 节流（每 N ms 批量 flush）：
  ```js
  let currentStream = null;
  let currentDateKey = '';
  let pendingLines = [];
  function ensureStream() { /* 跨日自动 rotate */ }
  function scheduleFlush() { setImmediate(drainBuffer); }
  ```
- 或更轻量：用 `fs.createWriteStream(path, { flags: 'a' })` 缓存当日句柄，每条日志 `.write(line)`，Node 内部会缓冲。跨日检测通过 `mtime` 或 `logFilePath()` 切换。
- **注意**：`exit` 时需要 `process.on('exit', drainBuffer)` 同步 flush 否则最后几条会丢。

### 1.2 [低影响 / 小改造] `extractStyleBlock` / `extractStructureOutline` 在每次 LLM 调用时都跑
**位置**：`src/server.js:145-181`（被 `eventPrompt` 调用）

**现状**：每次事件都重扫整个 `session.html`（可能 16KB+）做两次 regex 扫描，然后拼成 prompt。

**建议**：
- 把 `styleBlock` 缓存到 `session._cachedStyleBlock`；只在 HTML 真正替换时（`generateNextHtml` 完成 / `generateInitialHtml` 完成）失效。
- `extractStructureOutline` 类似，可以做"只在 HTML 长度变化 > 5% 时重算"或者"基于 `<main>` 起算位置增量计算"。

### 1.3 [低影响 / 小改造] `extractStructureOutline` 早期 `break` 截断的 prompt 价值
**位置**：`src/server.js:179-181`

```js
if (stack.length > 50) break;   // 截断
return out.slice(0, 60).join('\n');
```

**问题**：超过 50 深度或 60 行的 HTML 截断对 LLM 无意义（上下文连贯性断掉），但每次仍白付正则遍历全文本。

**建议**：先 `String(html).length` 阈值检查（> 32KB 直接用上一轮的 outline + 加 `<!-- truncated by depth -->{}`，省 CPU）。

---

## 2. LLM 调用层

### 2.1 [高影响 / 中改造] provider 缺乏重试 / 退避 / 限流细分
**位置**：`src/server.js:479-519`（`callOpenAi`）、`src/server.js:521-569`（`callAnthropic`）

**现状**：单次 `fetch` + `withTimeout`，失败立即抛出。所有错误（429/5xx/网络抖动/超时/JSON 解析）一视同仁。

**建议**：
- 区分错误类别并分级处理：
  | HTTP 状态 | 行为 |
  |---|---|
  | 429 | 读 `Retry-After` header，指数退避（最多 N 次） |
  | 5xx | 立即重试 1-2 次（不同实例通常瞬时恢复） |
  | 401/403 | 立即失败 + 友好报错（不重试） |
  | 网络 / abort | 立即重试 1 次 |
- 配合 `AbortSignal.timeout(ms)` 取代手动 `withTimeout`，少一层包装。
- 加 `providerStatus().circuitBreaker` 状态：连续 5 次失败后熔断 30s，期间 `/api/config` 返回 `degraded`，避免雪崩。

### 2.2 [中影响 / 中改造] token 估算用 `length/4` 严重失真
**位置**：`src/logger.js:101-103`（`estTok`）、调用方 `src/server.js:482, 524, 563, 566`

**现状**：中英文混排、CSS、HTML 标签都按"4 字符 = 1 token"算，误差 ±40%。日志字段 `tin` / `tou` 几乎不可信。

**建议**：
- 至少按字符类别分桶：CJK ≈ `length/1.5`、ASCII ≈ `length/4`、CSS 选 `length/3`。
- 真正准：用 `tiktoken`（但需新增依赖，与"零依赖"哲学冲突）——**或者明确把 `estTok` 改名为 `estChars`**，承认它是粗略指标。
- 加 `tiktoken-lite` 这种 0-dependency C 扩展的 npm 包是折中方案；不引入依赖则改进估算函数。

### 2.3 [中影响 / 小改造] `callOpenAi` / `callAnthropic` 重复结构
**位置**：`src/server.js:479-519` 与 `src/server.js:521-569`

**现状**：两段几乎一样：timer、chars 统计、withTimeout、fetch、status 判断、JSON 解析、text 提取、token 估算。

**建议**：抽一个 `createProvider({ name, url, buildBody, parseResponse })` 工厂。两边只保留差异（OpenAI 的 `response_format` 和 thinking 是 `extra_body`，Anthropic 的 thinking 是顶层字段）。

### 2.4 [中影响 / 小改造] Anthropic `filtered` 角色映射
**位置**：`src/server.js:528-531`

```js
const filtered = messages.filter(m => m.role !== 'system').map(m => ({
  role: m.role === 'assistant' ? 'assistant' : 'user',
  ...
}));
```

**问题**：当 system prompt 在前 + 第一条 user 是 "Create initial UI" + 一条 assistant 之后，Anthropic 的接口要求 `user → assistant` 严格交替。这里把所有非 assistant 一律映射成 `user`，会在多轮对话里产生"user → user" → 422。

**建议**：显式追踪 last role，必要时插入 placeholder（`{ role: 'assistant', content: '(see system)' }`）保证交替。

---

## 3. 会话 / 状态管理

### 3.1 [高影响 / 小改造] `generateNextHtml` 消息裁剪复杂度退化
**位置**：`src/server.js:445-454`

```js
while (session.messages.length > CONFIG.maxSessionMessages) {
  if (session.messages.length > 4 && session.messages[2].role === 'user' && session.messages[3]?.role === 'assistant') {
    session.messages.splice(2, 2);
  } else if (session.messages.length > 2) {
    session.messages.splice(2, 1);
  } else {
    break;
  }
}
```

**问题**：
- `Array.prototype.splice(2, 2)` 在 V8 上是 O(n-messages)，循环里反复调 → 总 O(n²) 行为；当 `maxSessionMessages=20` 且 history=100 时一次裁剪是 ~80 次移动。
- 显式依赖 `messages[0]` 是 initial intent、`messages[2..3]` 是 user/assistant 对，**靠位置耦合**。将来谁加一条 system 消息（比如 tool result）就会乱。
- 每次 `splice` 后 next iteration 还要重读 `session.messages[2]` / `[3]`，逻辑虽对但难读。

**建议**：
- 一次算好要丢多少条，再 splice：
  ```js
  const over = session.messages.length - CONFIG.maxSessionMessages;
  if (over > 0) session.messages.splice(2, over);
  ```
- 或更显式：维护 `session.conversationTurns = []`，每轮 push `{ user, assistant }`，裁剪时直接 slice 整个 turns 数组，再 flatten。

### 3.2 [中影响 / 中改造] sessions 在内存里无限增长
**位置**：`src/server.js:52`（`const sessions = new Map()`）

**现状**：用户关窗口后 session 仍驻留；`closeWindow` 只把它移到 `closedSessions`（前端），后端没有对应清理。

**建议**：
- 后端为每个 session 加 `lastActivityAt`（每次 `input_snapshot` / event 更新）。
- 加 `setInterval`（或 lazy GC）：遍历 sessions，删除 `lastActivityAt > 30min` 的。
- 或加 `DELETE /api/sessions/:id`，前端 `closeWindow` 时调用。

### 3.3 [中影响 / 小改造] 缺少并发写保护
**位置**：`generateNextHtml`（`src/server.js:415`）

**现状**：同一 session 上，前端 `enqueueSessionEvent` 用 `record.queue = record.queue.then(...)` 串行化，但**后端没有对应串行**。如果同一 session 在飞行中的事件还没返回时新事件进来（通过前端节流失败、用户狂点、多 tab），会触发"两个并发的 generateNextHtml 改同一份 session.html" → 状态错乱。

**建议**：session 内加 `inflight: Promise<void>` 字段，`generateNextHtml` 等前一个完成再跑。

---

## 4. HTML 解析 / 清洗

### 4.1 [中影响 / 中改造] `extractStructureOutline` 自行实现 stack 解析
**位置**：`src/server.js:150-181`

**问题**：
- LLM 经常产出 `<div><p>unclosed`、`<input>` 写成 `<input >`、`<br/>` vs `<br>` 混用。自写 stack 容易在 self-close 判断上出错。
- `</X>` 不做 `if (stack[top] === X)` 验证就 pop → 错位时后续结构完全错。
- 注释 `<!-- ... -->` 里的 `<` 会被当成开标签。

**建议**：
- 用一个轻量 HTML 解析器：`parse5`（0 依赖纯 JS，~50KB）或 `node-html-parser`（更轻量、API 友好）。
- 或退一步：先做"全文本中所有 `<tag>` 配对平衡性检查"，不平衡就直接 `outline = '(skipped: malformed html)'`，给 LLM 一个明确信号。
- **不要**因为追求 0 依赖就坚持手写——解析 HTML 是 LLM 化代码中最容易踩的坑。

### 4.2 [中影响 / 小改造] `stripUnsafeHtml` 反复创建 regex
**位置**：`src/model-output.js:19`（模块顶层 `STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi`）

**问题**：`/g` 标志 + `String.prototype.replace` 在某些 V8 版本下会共享 `lastIndex` 状态——`stripUnsafeHtml` 内部多次调用 `String.replace` 没事，但若未来有人在循环里复用同一个 regex 做 `.exec()`，会出 bug。

**建议**：
- 防御：把模块级 regex 改成局部 regex，或在 `replace` 前后 `lastIndex = 0`。
- 同样检查 `extractJsonStringField` 里 `new RegExp(...)`（每次调用都编译，浪费）。

### 4.3 [中影响 / 小改造] `parseJsonCandidate` 反复解析同一字符串
**位置**：`src/model-output.js:124-141`

**问题**：
- 5 个 `attempt` 实际上是从 `candidate` 派生的 5 个变体，其中 4 个都要走 `JSON.parse`。
- `candidate` 本身已经能 parse 成功时（最常见情况），其它 4 个 attempt 是浪费。
- 5 次 `JSON.parse` 失败时，V8 内部会留不少 garbage（错误对象）。

**建议**：
- 用 `try { return JSON.parse(candidate) } catch (firstErr) { ... }` 短路，第一个成功立刻返回。
- 5 个变体在 catch 里按代价递增排序，先试最便宜的（去掉 trailing comma），再试更重的（控制字符删除）。

### 4.4 [中影响 / 小改造] `looseExtractModelObject` 缺失 closure 优化
**位置**：`src/model-output.js:163-175`

**问题**：`extractJsonStringField` 内部 `new RegExp(\`"${field}"\\s*:\\s*"\`, 'i')` 每次调用都构造。

**建议**：模块顶层缓存：const `FIELD_RE = Object.fromEntries(['title','html','narration','explanation'].map(f => [f, new RegExp(...)]))`。

---

## 5. 前端 / iframe bridge

### 5.1 [高影响 / 小改造] `applyPatch` 失败后整页 `setIframeHtml` 闪屏
**位置**：`public/app.js:756-774`（`applyPatch`）、`public/app.js:702`（调用方）

**现状**：
```js
if (usedPatch && !patchOk) {
  record.lastPatchFailed = true;
}
if (!patchOk) setIframeHtml(win, result.html, sessionId, record.app?.appId);
```

**问题**：`srcdoc` 整页替换意味着 iframe 整个文档树重建：所有滚动位置、用户正在输入但未提交的文本、focus 状态全部丢失。LLM 选 patch 但 selector 不对——这是修复 patch 失败的最常见 case，**正是用户最不能接受闪屏的时刻**。

**建议**（按优先级）：
1. 在 `applyPatch` 内做"模糊匹配 fallback"：先 `querySelector(patch.selector)` 失败后，遍历所有元素找 `id` / 第一个匹配的 `data-vibe-action` / 第一个可写容器。
2. 模糊匹配再失败才 `setIframeHtml`，但**保留 iframe focus 上下文**：保存 `activeElement?.id`，新 srcdoc 后按 id restore。
3. 增加 `mode: 'tryDirectAppend'`：当 patch 完全无 selector 时，直接 append 到 `<main>` 末尾而不破坏现有 DOM。

### 5.2 [中影响 / 中改造] `inferSemanticAction` 启发式脆弱
**位置**：`public/app.js:491-506`

**问题**：
- 字符串包含检测（`label.includes('search')`）会误匹配 "research"、"searching..."、"Go to home"。
- 优先级顺序隐式：先匹配 `data-vibe-action`（好），但后面 `appId === 'tasks' && eventType === 'submit' return 'task.add'` 等强耦合到 appId，让新 app 上线就要改这里。
- LLM 改了 appId 名（如 'tasklist'）会全部失效。

**建议**：
- 强制 LLM 必须输出 `data-vibe-action`（已在 systemPrompt 提示），前端不依赖字符串启发式。
- 后端建一个 `SEMANTIC_ACTIONS` 注册表（按 appId 维度），LLM 输出 `data-vibe-action` → 客户端转换 → 服务端 fallback 推断。
- 真要保留兜底：用更严格的"白名单 + 长度限制"匹配（`label === 'search' || label.startsWith('search:')`）。

### 5.3 [中影响 / 小改造] `wrapIframeHtml` 每次都构造大字符串
**位置**：`public/app.js:338-352`

**现状**：HTML + 内联 `<script>` + `<style>` 每次替换都重建。

**问题**：
- LLM 一次响应可能 8-16KB；前端要序列化发送、内联 1KB 桥接脚本、每事件都重 parse 整个 script。
- iframe 用 `srcdoc` 而不是 `src=data:URL` —— 在 Chromium 上 srcdoc 会触发同源策略 "allow-same-origin" 之外的额外校验。

**建议**：
- 拆出 `BRIDGE_SCRIPT` 常量，只在 iframe document 上 postMessage 注册一次。
- 拆出 `BASE_STYLE` 常量拼接；变化的部分是 `${html}`。
- 用 template literal + cached fragments：

```js
const BRIDGE_SCRIPT = `<script>${SOURCE}</script>`;
function wrapIframeHtml(html, sessionId, appId) {
  return `<!doctype html>...<body>${html}${BRIDGE_SCRIPT.replace('${sid}', JSON.stringify(sessionId))...}`;
}
```

### 5.4 [中影响 / 小改造] `enqueueSessionEvent` 的 promise chain 有内存泄漏
**位置**：`public/app.js:661-668`

**问题**：
- `record.queue = (record.queue || Promise.resolve()).then(() => sendSessionEvent(...))` —— 每个新事件都把 callback 挂到 chain 上。
- 这个 chain 永远 resolve 不会被 `release`。
- `seq < lastAppliedSeq` 的旧事件仍会走完整个 sendSessionEvent（包括 fetch、HTML 替换），只是替换被守门员拦截。**但 `lastPatchFailed` 的 consume 已经发生**（`record.lastPatchFailed = false`），见 `sendSessionEvent` 681-684。这其实是个**逻辑 bug**：被丢弃的旧事件也会消费 lastPatchFailed 提示。

**建议**：
- 维护 `record.queue` 用真正的 FIFO 队列 + 显式 `next()`，每个 task 完成后从队列移除。
- 旧事件直接 `return` 之前要保留 lastPatchFailed 状态，或在 consume 处加 `if (seq < record.lastAppliedSeq) return` 后再消费。

### 5.5 [中影响 / 小改造] `boot()` 把多个 `await` 串起来
**位置**：`public/app.js:74-94`

**现状**：
```js
bindGlobalEvents();    // 同步
tickClock();           // 同步
setInterval(tickClock, 1000);
try {
  const config = await api('/api/config');   // 阻塞 boot 850ms 计时
  ...
}
setTimeout(() => el.boot.classList.add('hidden'), 850);
```

**问题**：
- `setTimeout(..., 850)` 是硬编码——网络快时 boot 屏幕白等 850ms 才隐藏。
- 实际上 `await api('/api/config')` 在本机 HTTP 不到 5ms，但隐藏动画固定 850ms。

**建议**：把 `hidden` 的触发改成"config 拿到 + 至少 N 帧渲染"双重条件。

### 5.6 [低影响 / 小改造] `startDrag` / `startResize` 闭包持有旧 rect
**位置**：`public/app.js:279-302`、`public/app.js:304-327`

**现状**：`function move(e)` 闭包持有 `rect`、`offsetX`、`offsetY`/`startW`、`startH`。窗口被 `classList.add('maximized')` 之后拖动—— `startDrag` 早就 bail，但 resize 的 `handle` 仍能点。

**建议**：resize 也加 `if (win.classList.contains('maximized')) return;`（已经有了，OK），并加 `e.preventDefault()` 之外的 `e.stopPropagation()`（已有）。

### 5.7 [低影响 / 小改造] clock 重复创建 Date
**位置**：`public/app.js:106-109`

**问题**：`setInterval(tickClock, 1000)` 每秒创建 `new Date()` + 一次 `Intl.DateTimeFormat` 调用 + 一次 DOM textContent 写入。`Intl.DateTimeFormat` 较贵（~1ms），每秒创建一次是浪费。

**建议**：在 `boot()` 顶层 `const clockFmt = new Intl.DateTimeFormat(...)` 复用。

---

## 6. 路由 / HTTP 边界

### 6.1 [中影响 / 小改造] `handleApi` 是大 switch，没有 method+path 路由表
**位置**：`src/server.js:594-645`

**问题**：
- 9 个 `if (req.method === '...' && url.pathname === '...')` 排成链，每条都做 string match。
- 重复模式：`sessionMatch = url.pathname.match(...)` 出现两次（GET /:id、POST /:id/event）。
- 缺幂等性保护：POST 创建后没 `Idempotency-Key` 支持，弱网重试会创建多个相同 session。

**建议**：
- 提一个 `route(req, url)` helper 内部用 `Object.create(null)` 路由表：
  ```js
  const ROUTES = [
    ['GET',  '/api/health', handleHealth],
    ['GET',  '/api/config', handleConfig],
    ['POST', '/api/sessions', handleCreateSession],
    ['POST', /^\/api\/sessions\/([^/]+)\/event$/, handleEventRoute],
    ...
  ];
  ```
- 抽到 `src/routes/` 目录的多个小文件；server.js 只剩 `createServer` 壳。

### 6.2 [中影响 / 小改造] 缺 CORS / origin 校验
**位置**：`src/server.js`（整个）

**现状**：
- 监听 `0.0.0.0` 默认（未设 host，Node 默认 `::`）—— 任何能访问 8765 端口的设备都能调你的 LLM、吃你的 API key 限额。
- 没有 CORS 头，浏览器同源 OK，但 mobile GPT client 经 proxy 接入时就裸奔。

**建议**：
- 显式 `server.listen(port, '127.0.0.1')`（如果只本机用）。
- 真要暴露 LAN，加 `req.headers.origin` 白名单。
- README 已写 "不要部署到公网"，但代码层面可以加一道防线。

### 6.3 [中影响 / 小改造] 缺请求体大小限制
**位置**：`src/server.js:108-121`（`readJson`）

**现状**：`for await (const chunk of req) chunks.push(chunk);` 没有任何大小上限。一个恶意 / 失控请求可以塞 1GB 内存。

**建议**：
```js
async function readJson(req, maxBytes = 1_000_000) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  ...
}
```

### 6.4 [低影响 / 小改造] `safeJoin` 缺 normalization
**位置**：`src/server.js:102-106`

```js
function safeJoin(base, requestedPath) {
  const resolved = path.resolve(base, requestedPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}
```

**问题**：
- Windows 上 `base = 'E:\AI_Projects\vibeos-demo\public'`，`requestedPath = '../src/server.js'` 不会逃出 base，但 `requestedPath = '/abs/path'` 走 `replace(/^\/+/, '')` 后变成 `'abs/path'`，`path.resolve('E:\\...\\public', 'abs/path')` 实际还是会逃出。
- 应再加一个"解码后 URL 必须以 base 为前缀"用 `path.relative(base, resolved)` 然后检查是否以 `..` 开头。

---

## 7. 配置 / 启动

### 7.1 [中影响 / 小改造] `loadEnv` 不支持转义、不支持行内注释
**位置**：`src/server.js:66-80`

**问题**：
- `key=value # 注释` 中 value 里含 `#` 时解析错（`ANTHROPIC_BASE_URL=https://x.com/v1#fragment` 会被截断）。
- `process.env[key] = value` 不会覆盖已有值（用 `if (!(key in process.env))`），意味着命令行传入的 `OPENAI_API_KEY=... node src/server.js` 优先级最低。
- 没有 `export FOO=bar` 解析。

**建议**：直接用 Node 自带 `--env-file=.env`（Node 20.6+，package.json 已要求 `>=20`），删 `loadEnv`：

```js
node --env-file=.env src/server.js
```

start.ps1 / start.cmd 同步加 `--env-file` 即可。

### 7.2 [中影响 / 小改造] `CONFIG` 对象可变性
**位置**：`src/server.js:29-50`

**现状**：`const CONFIG = { port, provider, openaiApiKey, ... }`，整个 server 共享。`runtime` 想换 provider？没门。

**建议**：包成 `getConfig()` / `setConfig()`，让"运行时热切换 provider"成为可能（demo 阶段不必，但写作函数式可让测试写起来更爽）。

---

## 8. 测试 / 工具链

### 8.1 [中影响 / 中改造] 多个核心模块零测试覆盖
**位置**：见 `codegraph_status` 中标注 `⚠️ no covering tests found` 的高危符号：

- `createSession`（`src/server.js:571`） — session 创建主路径
- `handleApi`（`src/server.js:594`） — 全部 HTTP 入口
- `serveStatic`（`src/server.js:648`） — 静态资源 + path traversal
- `providerStatus`（`src/server.js:123`） — readiness 信号
- `applyPatch`（`public/app.js:740`） — patch 失败判定
- `findWindowByApp`、`enqueueSessionEvent`、`sendSessionEvent` — 串行化逻辑
- `callOpenAi` / `callAnthropic` — provider 协议
- `safeJoin` — 安全敏感

**建议**：用 `node --test` + `node:http`'s `createServer` + `node:fetch` 直接打端到端：
```js
test('POST /api/sessions with missing key returns 200 missing_key', async () => {
  const server = await startTestServer({ OPENAI_API_KEY: '' });
  const resp = await fetch(`http://127.0.0.1:${port}/api/sessions`, { ... });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).mode, 'missing_key');
});
```

### 8.2 [中影响 / 小改造] 测试文件是"字符串 pattern matching"而非行为断言
**位置**：`tests/app-source.test.js`、`tests/patch-failure.test.js`、`tests/openapp-await-restore.test.js`、`tests/power-shell-silent.test.js`、`tests/readme-restart.test.js`

**问题**：用 `assert.match(appJs, /pattern/)` 测的是"代码里有没有这个字符串"，不是"行为对不对"。开发者重命名变量、加注释、拆分函数都会误报。

**建议**：在测试里有意识地混入"该匹配什么 + 不该匹配什么"两边：
```js
assert.match(appJs, /record\.lastPatchFailed\s*=\s*false/);
assert.doesNotMatch(appJs, /lastPatchFailed\s*=\s*true[\s\S]{0,200}return\s*;/); // 不要在赋值后立刻 return
```

但更应该补"功能型"测试见 8.1。

### 8.3 [中影响 / 小改造] `check` script 只跑 `node --check`
**位置**：`package.json:12`

```json
"check": "node --check src/server.js && node --check src/model-output.js && ..."
```

**问题**：语法正确 ≠ 行为正确。

**建议**：扩展为：
```json
"check": "node --check src/server.js && node --check src/model-output.js && node --check src/vibe-runtime.js && node --check public/app.js && node --test tests/*.test.js"
```

或拆 `lint` / `test` 两个 script。

### 8.4 [中影响 / 小改造] 无 ESLint / JSDoc / 类型
**位置**：全项目

**问题**：460+ 行的 `server.js` 没有任何 JSDoc 类型提示；函数参数全是 implicit any（JS 之痛）；IDE 跳转、refactor、catch 拼写错误都靠肉眼。

**建议**：
- 短期：补关键 export 函数（`createSession`、`generateWithParseRetry`、`applyPatch`）的 JSDoc。
- 中期：迁移到 `.mjs` + JSDoc `@typedef` + `// @ts-check`，零运行时成本。
- 长期：如真要做 demo 升级到 v2，转 TypeScript（但会牺牲"零工具链"卖点）。

---

## 9. 可维护性 / 代码组织

### 9.1 [中影响 / 大改造] `server.js` 单文件 700+ 行
**位置**：`src/server.js`

**建议拆分**：
```
src/
  server.js               # createServer + listen
  routes/
    api-health.js
    api-config.js
    sessions.js           # createSession, sessions map
    session-event.js      # generateNextHtml, eventPrompt
    static.js             # serveStatic, safeJoin
  llm/
    openai.js
    anthropic.js
    provider-factory.js
    retry.js
  prompts/
    system.js
    initial-user.js
    event.js
  runtime/
    sessions-store.js
    template-cache.js
```

每文件 < 200 行；`import` 即可。

### 9.2 [中影响 / 中改造] `THINKING_BUDGET_MAP` 在 server.js、`vibe-runtime.js` 重复定义
**位置**：`src/server.js:30-50` 与 `src/vibe-runtime.js` 内部的 `clampLevel` / `normalizeLevel`

**问题**：`THINKING_BUDGET_MAP`（off=0, low=1024, medium=4096, high=8192, max=16384）和 `LEVELS = ['off','low','medium','high','max']` 是同一个概念在两处维护。改一个会漏。

**建议**：统一到 `src/thinking-levels.js`，导出 `LEVELS`、`BUDGET`、`normalize`、`clamp`、`parse` 五个函数。server.js 和 vibe-runtime.js 都 import。

### 9.3 [中影响 / 小改造] magic numbers 散落
**位置**：
- `16000` (`stripUnsafeHtml` 默认)
- `500_000_000` (`safeJoin` 没出现)
- `120_000` (timeoutForModel)
- `45_000` (timeoutForModel base)
- `600`, `500`, `100`, `820`, `590` (defaultWidth/Height)
- `MAX_TEXT = 1200`, `MAX_TRACE = 20` (iframe bridge)
- `STYLE_BUDGET_RATIO = 0.6`

**建议**：每个文件顶部 `const CONFIG = { ... }` 集中管理；README 列"可调参数"。

### 9.4 [中影响 / 小改造] `extractStyleBlock` 与 `splitStyleAndBody` 行为不一致
**位置**：`src/server.js:145-148`（`extractStyleBlock`） vs `src/model-output.js:24-31`（`splitStyleAndBody`）

**问题**：前者只取**第一个** `<style>` 块的 CSS（且 `match` 是非全局的），后者取**所有**块的 CSS。LLM 在同一 HTML 里塞多个 `<style>` 时，eventPrompt 给模型的样式合约只反映了第一块。

**建议**：用同一个函数（export `splitStyleAndBody`），eventPrompt 那边 `blocks.join('\n')`。

### 9.5 [低影响 / 小改造] error 透传不可枚举
**位置**：`src/model-output.js:241`（`parseError: parsedResult.error`）

**问题**：把 `Error` 对象当字段传出去，JSON.stringify 后会丢 `stack`、`message` 之外的属性；前端用 `result.parseError?.message` 之前要重新包。

**建议**：序列化时只传 `parseError: parsedResult.error?.message || String(parsedResult.error)`。

---

## 10. 安全（demo 阶段适度关注）

### 10.1 [中影响 / 小改造] HTML 清洗正则可被 Unicode 旁路
**位置**：`src/model-output.js:45-49`

```js
out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
```

**问题**：
- `onerror=alert(1)` 中间有换行 `on\nerror=...` 不匹配。
- Unicode 全角字符 `ｏｎclick=` 不匹配，但浏览器仍能解析。
- `onclick` 之外的 `on*` 全捕获，但 SVG 的 `onload` 已经覆盖。

**建议**：用 `parse5` 或 `DOMPurify`（JSDOM 依赖较重）做规范化后再过滤；至少把 `[a-z]+` 改成 `[\w-]+` 并加 `s` flag + 处理换行。

### 10.2 [中影响 / 小改造] `getStaticAppResult` 把 HTML 字面量写在 JS 字符串里
**位置**：`src/vibe-runtime.js:93-118`

**问题**：未来扩展为"多语言 / 多主题 about 页面"时维护性差。

**建议**：放到 `public/static/about.html`，运行时读文件 + 缓存。

### 10.3 [低影响 / 小改造] sessions 全部在内存、无加密
**位置**：全局

**问题**：开发机器被入侵 → 所有 session state（含 LLM 上下文）泄露；不影响生产（demo 阶段），但 README 应明确警告。

---

## 11. 附：建议执行顺序

按"小改造 + 高影响"先做：

| 阶段 | 内容 | 估时 |
|---|---|---|
| **Phase 1（1-2h）** | 3.1 消息裁剪短路；5.1 applyPatch 模糊匹配；5.7 clock formatter 缓存；4.4 缓存 field regex | 1-2h |
| **Phase 2（半天）** | 1.1 logger 异步化；4.3 parseJsonCandidate 短路；2.4 anthropic 角色交替；6.3 请求体大小限制 | 3-4h |
| **Phase 3（1-2 天）** | 2.1 provider 重试 / 熔断；3.2 sessions GC；3.3 session inflight 串行；6.1 路由表化；8.1 补核心测试 | 1-2d |
| **Phase 4（可选）** | 9.1 server.js 拆分；4.1 用 parse5 重写 outline；7.1 迁 `--env-file`；8.2 测试升级到行为断言 | 各 0.5-1d |

**最大风险项**（改之前先 mock 全跑一次回归）：
- 1.1 logger 异步化（exit 时丢日志）
- 2.1 provider 重试（429/5xx 区分错误）
- 3.3 session inflight（前端 queue 后端串行化两套机制要对齐）
- 5.1 applyPatch fallback（DOM 结构兼容性）

---

**报告完。** 报告路径：`E:\AI_Projects\vibeos-demo\temp\OPTIMIZATION_ANALYSIS.md`。
（接下来若你点头开干，我会按 Phase 1 顺序逐一落地，每个改动单 commit + 单测试覆盖。）
