# AI 终端工具设计文档

**日期:** 2026-06-13
**分支:** `fix/ai-conversation`
**状态:** 草稿

---

## 目标

解决 AI 在终端中执行命令时的两个核心问题：
1. 命令进入交互式等待（sudo 密码、y/n 确认）时，AI 干等 60s 超时然后重复发命令
2. 长任务（npm install、docker build）被 60s 硬超时误判，AI 不知道命令还在跑

方案：不给前端硬编码规则，而是给 AI 一套工具，让 AI **自己决定**等待多久、何时输入密码、何时取消命令。

---

## 工具总览

7 个工具，按操作类型分三组：

### 执行命令

| 工具 | 发送命令 | 等待结果 | 返回 |
|------|:---:|:---:|---|
| `execute_command` | 是 | 等到标记或超时 | 完整或部分输出 |
| `start_command` | 是 | 仅等 3s 快照 | 启动输出 |

### 读取终端（不写任何东西）

| 工具 | 方式 | 返回 |
|------|------|------|
| `capture_terminal` | xterm.js 缓冲区瞬时快照 | 可见内容的最后 N 行 |
| `collect_output` | 监听 session:data N 秒 | 等待期间累积的新输出 |
| `get_terminal_state` | 查询会话元数据 | `{ pwd, user, shell, cols, rows }` |

### 控制终端（只写）

| 工具 | 作用 |
|------|------|
| `send_terminal_key` | 向终端发送文本或控制键 |
| `interrupt_command` | 发送 Ctrl+C（`\x03`） |

---

## 工具定义

### `execute_command` — 执行命令并等待结果

执行一条 shell 命令，等待其完成或超时。

```
输入参数:
  command:    string   — 要执行的 shell 命令
  risk:       "read" | "write" | "dangerous"   — 风险等级
  timeout:    number   — 最大等待秒数，默认 60，最小 5，最大 300
  head_lines: number   — 截断时保留的头部行数，默认 50
  tail_lines: number   — 截断时保留的尾部行数，默认 150

返回值:
  output:   string   — 命令输出（可能被截断）
  exitCode: number   — 0 成功，-1 超时或出错
  timedOut: boolean  — 是否超时

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**截断规则**：当总行数超过 `head_lines + tail_lines` 时，只保留头尾，中间用截断提示替换，标明省略的行数。

**超时返回格式**：
```
<已收集到的输出>

⚠️ 命令在 N 秒内未完成，可能仍在运行中。
请勿重复发送相同命令。
• 如果输出显示进度（百分比、文件名滚动等）→ 使用 collect_output 继续等待
• 如果输出显示密码/确认提示 → 使用 send_terminal_key 响应
• 如果命令卡住无响应 → 使用 interrupt_command 取消
```

### `start_command` — 启动命令不等待

启动一条命令但不等待完成，仅返回初始输出。

```
输入参数:
  command: string — 要执行的 shell 命令

返回值:
  output:  string — 前 3 秒内收集到的输出
  started: true

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**底层实现**：不走 `watchOutput`（因为后台命令永不退出，标记永远不会出现）。发送命令后，直接监听 `session:data` 3 秒，收集到的输出原样返回，3s 后清理监听器并返回。

使用场景：`npm run dev`、`redis-server`、`python -m http.server` 等后台/服务器进程。

### `capture_terminal` — 读取终端当前内容

从 xterm.js 缓冲区读取终端当前可见内容。瞬时操作，不等待。

"行"的定义：以 `\n` 分隔的逻辑行，非终端折行后的可视行。

```
输入参数:
  head_lines: number — 从缓冲区头部读取的行数，默认 0
  tail_lines: number — 从缓冲区尾部读取的行数，默认 50

返回值:
  output: string — 请求的行数，最新内容在底部

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**底层实现**：从 `xterm.buffer.active`（正常屏幕）或 `xterm.buffer.normal`（替代屏幕时）读取。每行通过 `line.translateToString()` 获取纯文本。

使用场景：检查命令完成后的屏幕状态、确认 shell 提示符是否已恢复、查看视口中的错误信息。

### `collect_output` — 等待并收集输出

等待并收集终端新输出。不发送功能性命令，仅往终端输入队列插入一个轻量标记用于检测当前命令是否完成。

```
输入参数:
  timeout:    number — 等待秒数，默认 30，最小 5，最大 120
  head_lines: number — 头部保留行数，默认 50
  tail_lines: number — 尾部保留行数，默认 150

返回值:
  output:   string  — 等待期间累积的输出
  timedOut: boolean — 等待时间是否耗尽

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**底层实现**：往终端输入队列中插入一个轻量标记 `echo "__AI_COLLECT_xxx__"`，然后监听 `session:data` 直到标记出现或超时。标记出现意味着 shell 提示符已恢复（当前命令已完成），标记被立即执行。如果标记在超时前未出现，返回已收集的内容。

使用场景：`execute_command` 超时后，命令还在跑，继续等。

### `get_terminal_state` — 获取终端状态

查询会话元数据，不执行任何命令。

```
输入参数: 无

返回值:
  pwd:   string — 当前工作目录（v1 返回 ""，留待 Go 后端 OSC 7 支持）
  user:  string — 当前用户（v1 返回 ""，留待 Go 后端支持）
  shell: string — shell 类型（bash、zsh、powershell、cmd 等）
  cols:  number — 终端列数
  rows:  number — 终端行数

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**底层实现**：v1 从 panel config 返回 shell、cols、rows。pwd/user 留待后续 Go 后端支持（通过 OSC 7 转义序列等机制获取）。

### `send_terminal_key` — 发送终端输入

向终端发送文本或控制字符。

```
输入参数（二选一）:
  input:   string                         — 要发送的文本（如密码、"y"、"n"）
  control: "ctrl_c" | "ctrl_d" | "enter"   — 控制字符

返回值:
  output: string — 发送后 5 秒窗口内捕获的即时响应
```

**限制**：
- 不提供 `ctrl_l`（清屏）— 用户必须始终能看到 AI 的操作历史
- 发送后附加一个短超时标记以捕获即时响应

错误:
  无活跃终端会话时抛出 "No active terminal session"

### `interrupt_command` — 中断当前命令

发送 Ctrl+C 取消正在运行的命令。

```
输入参数: 无

返回值:
  output: string — 中断后捕获的输出

错误:
  无活跃终端会话时抛出 "No active terminal session"
```

**底层实现**：与 `send_terminal_key(undefined, 'ctrl_c')` 走相同路径。独立成工具是为了让系统提示词语义更清晰。

---

## 架构

### 核心原语：`watchOutput`

所有需要监听终端输出的工具共享同一个 `watchOutput` 原语：

```
watchOutput(sessionId, marker, timeoutMs) → { promise, cleanup }

promise 解析为:
  { output: string, timedOut: boolean }
```

**工作流程**：
1. 订阅 `session:data` 事件（按 sessionId 过滤）
2. 将每块数据追加到缓冲区，去除 ANSI 控制码
3. 在缓冲区中扫描标记字符串
4. 第一次出现 = 命令本身的 echo → 跳过
5. 第二次出现 = 标记被执行 → 命令完成 → resolve
6. 超时触发 → 返回已收集的输出 + `timedOut: true`
7. 清理：清除定时器 + 取消 `session:data` 订阅

### 工具组合关系

```
execute_command(cmd, timeout, head, tail)
  → SessionWrite(cmd + "echo 'MARKER'" + newline)
  → watchOutput(sessionId, marker, timeout)
  → truncate(output, head, tail)
  → return { output, exitCode, timedOut }

start_command(cmd)
  → SessionWrite(cmd + newline)
  → 监听 session:data 3 秒（纯时间等待，不走 watchOutput）
  → 3s 后清理监听器
  → return { output, started: true }

collect_output(timeout, head, tail)
  → SessionWrite("echo 'MARKER'" + newline)   // 轻量标记，排入输入队列
  → watchOutput(sessionId, marker, timeout)
  → truncate(output, head, tail)
  → return { output, timedOut }

send_terminal_key(input?, control?)
  → 解析为数据字符串
  → SessionWrite(data)
  → SessionWrite("echo 'MARKER'" + newline)
  → watchOutput(sessionId, marker, 5000)
  → return { output }

interrupt_command()
  → 等同于 send_terminal_key(undefined, 'ctrl_c')

capture_terminal(head, tail)
  → 直接从 xterm.js 缓冲区读取
  → 不走 watchOutput，无网络调用

get_terminal_state()
  → 从 panel config 读取（shell、cols、rows）
  → 不走 watchOutput，无网络调用
```

---

## 输出截断格式

"行"的定义：以 `\n` 字符分隔的逻辑行（非终端折行后的可视行）。

当输出总行数超过 `head_lines + tail_lines` 时，使用以下格式：

```
<头部第 1 行>
<头部第 2 行>
...
<头部第 N 行>

─────── [截断: 共 X 行, 已省略 Y 行] ────────
调整 head_lines / tail_lines 参数可查看更多内容。

<尾部第 1 行>
<尾部第 2 行>
...
<尾部第 N 行>
```

当总行数未超过阈值时，原样返回，不显示截断标记。

---

## 系统提示词变更

更新 `aiStore.ts` 中的 `SYSTEM_RULES`：

1. 将硬编码的"60 秒超时"替换为工具描述
2. 添加"超时指南"章节，给出各场景的建议超时值
3. 添加"超时处理决策树"章节
4. 添加"交互式提示"章节
5. 添加输出读取指导（collect_output vs capture_terminal）
6. 禁止 AI 执行 `clear`/`cls` 等清屏命令
7. 添加 head_lines/tail_lines 使用指导

### AI 行为规则（要点）

```
超时指南:
- 5-10s:  快速命令（ls、cat、pwd、whoami）
- 15-30s: 中等命令（grep、find、df、systemctl status）
- 60-120s: 构建/安装（npm install、pip install、apt-get）
- 120-300s: 超长任务（docker build、大型 git clone、完整编译）

超时处理决策树:
1. 仔细阅读输出，尤其是最后 10 行
2. 看到进度（百分比、文件名滚动）→ collect_output 继续等
3. 看到密码/确认提示 → 询问用户，然后用 send_terminal_key
4. 空输出或乱码 → interrupt_command 取消，重新评估
5. 超时后严禁重新发送 execute_command — 使用 collect_output

交互式提示:
- 看到密码提示 → 询问用户（禁止猜测密码）
- 看到 y/n 确认 → send_terminal_key(input: "y")
- 看到 [sudo] password → 询问用户 sudo 密码

输出读取:
- 命令已返回但不确定 shell 是否就绪 → 用 capture_terminal
- collect_output 排队标记并等待，仅在命令正在运行时有效
```

---

## 文件变更

| 文件 | 变更内容 |
|------|---------|
| `frontend/src/services/terminalAgent.ts` | 新增 `watchOutput`，重写 `executeCommand`，新增 `startCommand`、`collectOutput`、`sendTerminalKey` |
| `frontend/src/services/llm.ts` | 在 `AVAILABLE_TOOLS` 中新增 6 个工具定义，更新 `execute_command` 输入参数 |
| `frontend/src/services/agent.ts` | 在 `runAgent()` 中处理新工具调用，按需更新 `getRisk()` |
| `frontend/src/stores/aiStore.ts` | 重写 `SYSTEM_RULES` |
| `frontend/src/types/ai.ts` | 按需新增工具结果类型 |

本次不涉及 Go 后端变更（v1 全部在前端实现）。`get_terminal_state` 的 pwd/user 字段留待后端升级。

---

## 典型场景验证

| 场景 | 预期 AI 行为 |
|------|-------------|
| `sudo systemctl restart nginx` | `execute_command` 超时 → AI 看到 `[sudo] password` → 询问用户 → `send_terminal_key` |
| `npm install` | `execute_command(timeout=120)` → 可能超时 → `collect_output(timeout=60)` → 完成 |
| `ssh user@host` | 超时 → AI 看到密码提示 → 询问用户 |
| `sleep 100` | 超时无实质输出 → `capture_terminal` 确认空闲 → AI 向用户报告 |
| `cat /var/log/syslog` | 输出超过 200 行被截断 → 显示截断标记 → AI 可调大 limits 重试 |
| `npm run dev` | `start_command` → 立即返回启动输出 → AI 确认服务器已启动 |

---

## 明确排除

- AI 猜测密码（必须询问用户）
- `send_terminal_key` 提供 `ctrl_l`（禁止清屏）
- `execute_command` 执行 `clear`/`cls` 等清屏命令（系统提示词中禁止）
- `get_terminal_state` 通过执行命令获取 pwd/user（必须无副作用，纯被动读取）
- AI 在后台异步写入终端（不提供异步写入工具）
- 方案一的交互式提示正则检测（不依赖模式匹配，由 AI 自主判断）
