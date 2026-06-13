# AI Terminal Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI fine-grained control over command execution — configurable timeout, passive output collection, interactive terminal input (passwords, confirmations), and command cancellation.

**Architecture:** A shared `watchOutput` primitive (marker-based completion detection) powers `execute_command` and `send_terminal_key`. `start_command` and `collect_output` use pure time-based `session:data` listening (no marker). `capture_terminal` reads xterm.js buffer directly. `interrupt_command` sends Ctrl+C and captures immediate response.

**Tech Stack:** Vue 3 + TypeScript (frontend only), Wails v2 runtime. No Go backend changes.

**Design spec:** `.superpowers/specs/2026-06-13-ai-terminal-tools-design.md`

**Current branch:** `fix/ai-conversation`

---

## File Structure

| File | Role | Change |
|------|------|--------|
| `frontend/src/services/terminalAgent.ts` | Core: watchOutput + all 6 tool functions | Extract `watchOutput`, rewrite `executeCommand`, add `startCommand`, `captureTerminal`, `collectOutput`, `sendTerminalKey` |
| `frontend/src/services/llm.ts` | Tool definitions for LLM API | Add 5 new tool schemas, update `execute_command` |
| `frontend/src/services/agent.ts` | Agent loop: route tool calls | Handle 5 new tool names in `runAgent()` |
| `frontend/src/stores/aiStore.ts` | System prompt | Rewrite `SYSTEM_RULES` |

---

### Task 1: Extract `watchOutput` Primitive

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** The current `executeCommand` (lines 11-95) has marker-based output watching and timeout logic baked into an inline Promise. Extract this into a standalone `watchOutput` function that returns `{ promise, cleanup }`, so `execute_command` and `send_terminal_key` can share it.

- [ ] **Step 1: Add `watchOutput` before `executeCommand`**

In `frontend/src/services/terminalAgent.ts`, insert between the `ExecuteResult` interface (line 9) and the `executeCommand` function (line 11):

```typescript
interface WatchResult {
  output: string
  timedOut: boolean
}

function watchOutput(
  sessionId: string,
  marker: string,
  timeoutMs: number
): { promise: Promise<WatchResult>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>
  let unsubscribe: (() => void) | null = null
  let resolved = false
  let output = ''
  let lastScanPos = 0
  let markerSeen = false

  const cleanup = () => {
    clearTimeout(timeoutId)
    unsubscribe?.()
    resolved = true
  }

  const promise = new Promise<WatchResult>((resolve) => {
    unsubscribe = EventsOn('session:data', (payload: { id: string; data: string }) => {
      if (payload.id !== sessionId || resolved) return

      output += payload.data
      const clean = stripAnsi(output)

      const scanStart = Math.max(0, lastScanPos - marker.length)
      lastScanPos = clean.length
      let searchIdx = scanStart
      while ((searchIdx = clean.indexOf(marker, searchIdx)) !== -1) {
        searchIdx += marker.length
        if (!markerSeen) {
          markerSeen = true
          continue
        }
        cleanup()
        const result = clean.slice(0, searchIdx - marker.length).trim()
        resolve({ output: result, timedOut: false })
        return
      }
    })

    timeoutId = setTimeout(() => {
      cleanup()
      resolve({
        output: stripAnsi(output).trim(),
        timedOut: true,
      })
    }, timeoutMs)
  })

  return { promise, cleanup }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "refactor(ai): extract watchOutput primitive from executeCommand"
```

---

### Task 2: Rewrite `executeCommand` with Configurable Timeout

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts:11-95`

**Background:** Replace the current `executeCommand` body to use `watchOutput`, add `timeoutMs` parameter, add `head_lines`/`tail_lines` truncation, and enrich the timeout return message with guidance for the AI.

- [ ] **Step 1: Add truncation helper**

Add before `executeCommand` (after `watchOutput`):

```typescript
function truncateOutput(
  text: string,
  headLines: number,
  tailLines: number
): string {
  const lines = text.split('\n')
  const total = lines.length
  const threshold = headLines + tailLines
  if (total <= threshold) return text

  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(total - tailLines).join('\n')
  const omitted = total - headLines - tailLines
  return `${head}\n\n─────── [截断: 共 ${total} 行, 已省略 ${omitted} 行] ────────\n调整 head_lines / tail_lines 参数可查看更多内容。\n\n${tail}`
}
```

- [ ] **Step 2: Rewrite `executeCommand`**

Replace the function body (lines 11-95) with:

```typescript
export async function executeCommand(
  command: string,
  timeoutMs: number = 60000,
  headLines: number = 50,
  tailLines: number = 150
): Promise<ExecuteResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const sessionId = panel.sessionId
  const marker = `__AI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`
  const shellPath = panel.config?.shellPath
  const fullCommand = buildCommand(command, marker, shellPath)

  const lowerShell = (shellPath || '').toLowerCase()
  let newline: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    newline = '\r'
  } else if (lowerShell.includes('cmd')) {
    newline = '\r\n'
  } else if (lowerShell.includes('bash') || lowerShell.includes('sh')) {
    newline = '\r\n'
  } else {
    newline = '\n'
  }

  await SessionWrite(sessionId, fullCommand + newline)

  const { promise } = watchOutput(sessionId, marker, timeoutMs)
  const result = await promise

  if (result.timedOut) {
    const truncated = truncateOutput(result.output, headLines, tailLines)
    const timeoutSec = Math.round(timeoutMs / 1000)
    return {
      output: truncated
        + `\n\n⚠️ 命令在 ${timeoutSec}s 内未完成，可能仍在运行中。\n`
        + `请勿重复发送相同命令。\n`
        + `• 如果输出显示进度（百分比、文件名滚动等）→ 使用 collect_output 继续等待\n`
        + `• 如果输出显示密码/确认提示 → 使用 send_terminal_key 响应\n`
        + `• 如果命令卡住无响应 → 使用 interrupt_command 取消`,
      exitCode: -1,
      timedOut: true,
    }
  }

  return {
    output: truncateOutput(result.output, headLines, tailLines),
    exitCode: 0,
    timedOut: false,
  }
}
```

- [ ] **Step 3: Update `ExecuteResult` to include `timedOut`**

At line 6-9, update the interface:

```typescript
export interface ExecuteResult {
  output: string
  exitCode: number
  timedOut?: boolean
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): rewrite executeCommand with configurable timeout and truncation"
```

---

### Task 3: Add `startCommand` — Fire-and-Forget

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** `start_command` sends a command and collects output for 3 seconds, then returns. It does NOT append a marker or use `watchOutput` (background commands never exit, so a marker would never appear).

- [ ] **Step 1: Add `startCommand`**

Add after `executeCommand` in `frontend/src/services/terminalAgent.ts`:

```typescript
interface StartResult {
  output: string
  started: boolean
}

export async function startCommand(command: string): Promise<StartResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const sessionId = panel.sessionId
  const shellPath = panel.config?.shellPath

  const lowerShell = (shellPath || '').toLowerCase()
  let newline: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    newline = '\r'
  } else if (lowerShell.includes('cmd')) {
    newline = '\r\n'
  } else if (lowerShell.includes('bash') || lowerShell.includes('sh')) {
    newline = '\r\n'
  } else {
    newline = '\n'
  }

  await SessionWrite(sessionId, command + newline)

  // Collect output for 3 seconds, then return
  return new Promise((resolve) => {
    let output = ''
    const unsubscribe = EventsOn('session:data', (payload: { id: string; data: string }) => {
      if (payload.id !== sessionId) return
      output += payload.data
    })

    setTimeout(() => {
      unsubscribe()
      resolve({
        output: stripAnsi(output).trim(),
        started: true,
      })
    }, 3000)
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add startCommand for fire-and-forget background commands"
```

---

### Task 4: Add `captureTerminal` — xterm.js Buffer Snapshot

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** `capture_terminal` reads the current visible content from the xterm.js buffer. It accesses the shared terminal instance via `getManagedTerminal`, reads buffer lines, and returns a plain-text snapshot.

- [ ] **Step 1: Check `getManagedTerminal` export**

Read the existing import at the top of `terminalAgent.ts`. The import from `../services/terminalManager` should include `getManagedTerminal`. If not present, add it in this step.

Current imports (line 1-3):
```typescript
import { EventsOn } from '../../wailsjs/runtime'
import { SessionWrite } from '../../wailsjs/go/main/App'
import { useTabStore } from '../stores/tabStore'
import { usePanelStore } from '../stores/panelStore'
```

- [ ] **Step 2: Add import for terminalManager**

Add after line 3:
```typescript
import { getManagedTerminal } from '../services/terminalManager'
```

- [ ] **Step 3: Add `captureTerminal`**

Add after `startCommand` in `frontend/src/services/terminalAgent.ts`:

```typescript
interface CaptureResult {
  output: string
}

export function captureTerminal(headLines: number = 0, tailLines: number = 50): CaptureResult {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const managed = getManagedTerminal(panel.sessionId)
  if (!managed || !managed.terminal) {
    return { output: '' }
  }

  const terminal = managed.terminal
  const buffer = terminal.buffer.active
  const totalLines = buffer.length

  if (totalLines === 0) {
    return { output: '' }
  }

  const lines: string[] = []
  const effectiveHead = Math.min(headLines, totalLines)
  const effectiveTail = Math.min(tailLines, totalLines - effectiveHead)

  for (let i = 0; i < effectiveHead; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString())
  }

  if (effectiveHead + effectiveTail < totalLines) {
    lines.push(`... (${totalLines - effectiveHead - effectiveTail} 行省略) ...`)
  }

  for (let i = totalLines - effectiveTail; i < totalLines; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString())
  }

  return { output: lines.join('\n') }
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add captureTerminal for xterm.js buffer snapshot"
```

---

### Task 5: Add `collectOutput` — Passive Output Collection

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** `collect_output` is purely passive — subscribes to `session:data` for N seconds, accumulates output, returns. No `SessionWrite`, no marker, no `watchOutput`.

- [ ] **Step 1: Add `collectOutput`**

Add after `captureTerminal` in `frontend/src/services/terminalAgent.ts`:

```typescript
interface CollectResult {
  output: string
  timedOut: boolean
}

export async function collectOutput(
  timeoutMs: number = 30000,
  headLines: number = 50,
  tailLines: number = 150
): Promise<CollectResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  return new Promise((resolve) => {
    let output = ''
    const unsubscribe = EventsOn('session:data', (payload: { id: string; data: string }) => {
      if (payload.id !== panel!.sessionId) return
      output += payload.data
    })

    setTimeout(() => {
      unsubscribe()
      resolve({
        output: truncateOutput(stripAnsi(output).trim(), headLines, tailLines),
        timedOut: true,
      })
    }, timeoutMs)
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add collectOutput for passive terminal output collection"
```

---

### Task 6: Add `sendTerminalKey` — Interactive Input

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** `send_terminal_key` sends text or a control character to the terminal, then watches for immediate response using a short-lived marker. Supports `ctrl_c`, `ctrl_d`, and `enter` controls.

- [ ] **Step 1: Add `sendTerminalKey`**

Add after `collectOutput` in `frontend/src/services/terminalAgent.ts`:

```typescript
interface SendKeyResult {
  output: string
}

export async function sendTerminalKey(
  input?: string,
  control?: 'ctrl_c' | 'ctrl_d' | 'enter'
): Promise<SendKeyResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  // Parameter validation
  let data: string
  if (control) {
    if (control === 'ctrl_c') {
      data = '\x03'
    } else if (control === 'ctrl_d') {
      data = '\x04'
    } else if (control === 'enter') {
      data = '\n'
    } else {
      data = ''
    }
  } else if (input !== undefined && input !== '') {
    data = input
  } else {
    throw new Error('Either input or control must be provided')
  }

  await SessionWrite(panel.sessionId, data)

  // Queue a short marker to capture immediate response
  const marker = `__AI_KEY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`
  const shellPath = panel.config?.shellPath
  const lowerShell = (shellPath || '').toLowerCase()
  let markerCmd: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    markerCmd = `Write-Output "${marker}"`
  } else if (lowerShell.includes('cmd')) {
    markerCmd = `echo ${marker}`
  } else {
    markerCmd = `echo "${marker}"`
  }

  let newline: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    newline = '\r'
  } else if (lowerShell.includes('cmd')) {
    newline = '\r\n'
  } else if (lowerShell.includes('bash') || lowerShell.includes('sh')) {
    newline = '\r\n'
  } else {
    newline = '\n'
  }

  await SessionWrite(panel.sessionId, markerCmd + newline)

  const { promise } = watchOutput(panel.sessionId, marker, 5000)
  const result = await promise

  return { output: result.output || '(input sent)' }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add sendTerminalKey for interactive terminal input"
```

---

### Task 7: Add New Tool Definitions to `AVAILABLE_TOOLS`

**Files:**
- Modify: `frontend/src/services/llm.ts:101-121`

**Background:** Register the 5 new tools and update `execute_command` with new parameters. The existing `AVAILABLE_TOOLS` array at lines 101-121 contains only `execute_command`.

- [ ] **Step 1: Replace `AVAILABLE_TOOLS`**

Replace lines 101-121 in `frontend/src/services/llm.ts`:

```typescript
export const AVAILABLE_TOOLS = [
  {
    name: 'execute_command',
    description: 'Execute a shell command in the active terminal session and return its output. You MUST classify every command with a risk level. Use "timeout" to control how long to wait — short commands need less time, long tasks (builds, installs) need more.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. Use syntax appropriate for the current shell (provided in context).'
        },
        risk: {
          type: 'string',
          enum: ['read', 'write', 'dangerous'],
          description: 'The risk level of this command:\n- "read": only inspects/views data, absolutely no modifications (e.g. ls, cat, grep, head, tail, df, du, ps, top, find, pwd, whoami, git status, git log, docker ps, npm list)\n- "write": modifies or creates data but not system-destructive (e.g. echo > file, touch, mkdir, cp, mv, git commit, curl POST, npm install, pip install)\n- "dangerous": potentially destructive or system-altering (e.g. rm, > overwrite, chmod, chown, shutdown, mkfs, dd, reboot, force push)'
        },
        timeout: {
          type: 'number',
          description: 'Maximum seconds to wait for command completion. Default 60s. Use 5-10s for quick commands (ls, cat, pwd), 30-60s for moderate tasks, 120-300s for long tasks (npm install, docker build, git clone). NEVER set below 5s.'
        },
        head_lines: {
          type: 'number',
          description: 'Number of lines to keep from the START of output when truncation occurs. Default 50. Increase to see more of the beginning.'
        },
        tail_lines: {
          type: 'number',
          description: 'Number of lines to keep from the END of output when truncation occurs. Default 150. Increase to see more recent output (errors usually at the end).'
        }
      },
      required: ['command', 'risk']
    }
  },
  {
    name: 'start_command',
    description: 'Start a background/long-running command and return its initial output (first 3 seconds). Use this for servers (npm run dev, redis-server, python -m http.server) or any command you do NOT want to wait for.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to start. It will keep running after this tool returns.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'capture_terminal',
    description: 'Take an instant snapshot of the terminal screen. Use this to check what is currently visible without running any command. Useful after a command times out or returns, to see if the shell prompt is back or to read error messages on screen.',
    input_schema: {
      type: 'object',
      properties: {
        head_lines: {
          type: 'number',
          description: 'Lines from the top of the buffer. Default 0.'
        },
        tail_lines: {
          type: 'number',
          description: 'Lines from the bottom of the buffer. Default 50. Increase to see more of the recent output.'
        }
      }
    }
  },
  {
    name: 'collect_output',
    description: 'Wait and collect terminal output WITHOUT sending any command or text to the terminal. Pure passive listening. Use this when a command is still running and you want to wait for more output. You can call this repeatedly to wait in stages.',
    input_schema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Seconds to wait. Default 30s. Use 15-30s for active progress checks, 60-120s for slower operations.'
        },
        head_lines: {
          type: 'number',
          description: 'Head lines to keep on truncation. Default 50.'
        },
        tail_lines: {
          type: 'number',
          description: 'Tail lines to keep on truncation. Default 150.'
        }
      }
    }
  },
  {
    name: 'send_terminal_key',
    description: 'Send text or a control character to the active terminal. Use this ONLY when you can SEE an interactive prompt in the output (password request, y/n confirmation, etc.). NEVER guess that a prompt is there.',
    input_schema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Text to send to the terminal (e.g., a password, "y" for confirmation, or a command fragment).'
        },
        control: {
          type: 'string',
          enum: ['ctrl_c', 'ctrl_d', 'enter'],
          description: 'Send a control character instead of text. "ctrl_c" interrupts/cancels the running command. "ctrl_d" sends EOF. "enter" sends a newline/Enter key.'
        }
      }
    }
  },
  {
    name: 'interrupt_command',
    description: 'Send Ctrl+C to cancel the currently running command. Use this when a command is stuck, hanging, or needs to be stopped before running a different command.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
]
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/llm.ts
git commit -m "feat(ai): add 5 new tool definitions to AVAILABLE_TOOLS"
```

---

### Task 8: Handle New Tool Calls in Agent Loop

**Files:**
- Modify: `frontend/src/services/agent.ts:1-3` (imports)
- Modify: `frontend/src/services/agent.ts:334-380` (tool handling)

**Background:** `runAgent()` currently only handles `execute_command`. Add handlers for `start_command`, `capture_terminal`, `collect_output`, `send_terminal_key`, and `interrupt_command`.

- [ ] **Step 1: Update imports**

Change line 2 in `frontend/src/services/agent.ts`:

```typescript
// Before:
import { executeCommand } from './terminalAgent'

// After:
import { executeCommand, startCommand, captureTerminal, collectOutput, sendTerminalKey } from './terminalAgent'
```

- [ ] **Step 2: Add `getActivePanel` as a shared helper (extract if not already exported)**

The `getActivePanel` logic is duplicated across `terminalAgent.ts` and `agent.ts`. For this task, use the existing inline logic. The tool handlers in `agent.ts` should pass timeout/head_lines/tail_lines extracted from `tu.input`.

- [ ] **Step 3: Replace the tool handling block**

Locate the existing `execute_command` handler in `runAgent()` (around lines 334-379). Replace the entire block below `const tu = toolUses[0]` with:

```typescript
    const tu = toolUses[0]
    if (tu.name === 'execute_command') {
      const command = tu.input.command as string
      const timeoutSec = (tu.input.timeout as number) || 60
      const timeoutMs = Math.max(5000, Math.min(timeoutSec * 1000, 300000))
      const headLines = (tu.input.head_lines as number) ?? 50
      const tailLines = (tu.input.tail_lines as number) ?? 150
      const risk = getRisk(tu)

      if (shouldConfirm(risk)) {
        store.setPendingCommand({
          messageId: assistantMsg.id,
          toolId: tu.id,
          command,
          risk,
          dangerous: risk === 'dangerous'
        })
        assistantMsg.tool_calls = [{
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input)
          }
        }]
        store.isRunning = false
        cleanupStreamListeners()
        return
      }

      try {
        const result = await executeCommand(command, timeoutMs, headLines, tailLines)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output,
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error executing command: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'start_command') {
      const command = tu.input.command as string
      try {
        const result = await startCommand(command)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || '(command started)',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error starting command: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'capture_terminal') {
      const headLines = (tu.input.head_lines as number) ?? 0
      const tailLines = (tu.input.tail_lines as number) ?? 50
      try {
        const result = captureTerminal(headLines, tailLines)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || '(terminal is empty)',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error capturing terminal: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'collect_output') {
      const timeoutSec = (tu.input.timeout as number) || 30
      const timeoutMs = Math.max(5000, Math.min(timeoutSec * 1000, 120000))
      const headLines = (tu.input.head_lines as number) ?? 50
      const tailLines = (tu.input.tail_lines as number) ?? 150
      try {
        const result = await collectOutput(timeoutMs, headLines, tailLines)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output,
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error collecting output: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'send_terminal_key') {
      const input = tu.input.input as string | undefined
      const control = tu.input.control as string | undefined
      try {
        const result = await sendTerminalKey(
          input,
          control as 'ctrl_c' | 'ctrl_d' | 'enter' | undefined
        )
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || '(input sent)',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error sending terminal input: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'interrupt_command') {
      try {
        const result = await sendTerminalKey(undefined, 'ctrl_c')
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || 'Sent Ctrl+C to interrupt the running command.',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error sending Ctrl+C: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    }
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/agent.ts
git commit -m "feat(ai): handle 5 new tool calls in agent loop"
```

---

### Task 9: Update System Prompt

**Files:**
- Modify: `frontend/src/stores/aiStore.ts:48-77`

**Background:** Replace the hardcoded "60-second timeout" reference with comprehensive tool descriptions, timeout guidelines, and the decision tree for handling timeouts from the spec.

- [ ] **Step 1: Replace `SYSTEM_RULES`**

Replace lines 48-77 in `frontend/src/stores/aiStore.ts`:

```typescript
const SYSTEM_RULES = `You are an AI assistant inside uniTerm, a terminal emulator. You can execute shell commands in the user's active terminal to help them complete tasks.

AVAILABLE TOOLS:
1. execute_command — Run a shell command and wait for its output. Set timeout based on expected duration. Use head_lines/tail_lines to control how much output you receive.
2. start_command — Start a background/long-running command (servers, daemons). Returns initial output immediately without waiting.
3. capture_terminal — Take an instant snapshot of the terminal screen. Use to check current state without running commands.
4. collect_output — Wait and collect new terminal output. Pure passive listening — does NOT send anything to the terminal. Use when a command is still running and you want to see progress.
5. send_terminal_key — Send text or control keys to the terminal. Use ONLY when you can SEE an interactive prompt (password, y/n, confirmation).
6. interrupt_command — Send Ctrl+C to cancel the running command.

CRITICAL RULES:
- You can only send ONE tool call at a time. Never send multiple tool calls in a single response.
- Always explain what you are about to do before executing commands.
- If a command might be destructive, warn the user.

TIMEOUT GUIDELINES:
- 5-10s: quick commands (ls, cat, pwd, whoami)
- 15-30s: moderate commands (grep, find, df, systemctl status)
- 60-120s: build/install tasks (npm install, pip install, apt-get)
- 120-300s: very long tasks (docker build, large git clone, full compilation)

HANDLING TIMEOUTS:
When execute_command times out, read the output carefully:
- If output shows progress (percentages, file names scrolling): use collect_output to keep waiting.
- If output shows a prompt (password, y/n, [sudo], "Are you sure?"): ask the user for credentials, then use send_terminal_key.
- If output is empty or shows an error: use interrupt_command, then reassess.
- NEVER re-send the same command after a timeout — this causes duplicate commands to pile up.

INTERACTIVE PROMPTS:
- Password prompt: ask the user (NEVER guess passwords).
- y/n confirmation: use send_terminal_key with input: "y".
- Pager (less/more): use send_terminal_key with control: "ctrl_c" to exit.

OUTPUT READING:
- To check if shell prompt is back after a command: use capture_terminal.
- To track progress of a running command: use collect_output.
- Output was truncated: adjust head_lines/tail_lines and re-run.

PROHIBITED:
- NEVER execute clear/cls/Reset. The user must always see command history.
- NEVER use send_terminal_key with unknown prompts — you must SEE the prompt first.
- NEVER send multiple tool calls in one response.

SHELL AWARENESS:
- At the START of EVERY response, read the shell/panel context in the user's message. IGNORE any memory of what the previous shell was — only the latest context matters.
- The user may switch terminal tabs at any time. Each terminal is an independent environment.
- When the terminal type changes, switch to the NEW shell's command syntax immediately.
- Do NOT invoke a different shell executable from within the current terminal.

RISK CLASSIFICATION:
Every execute_command call MUST include a "risk" field:
- "read": only inspects/views data, no modifications at all
- "write": modifies or creates data, but not system-destructive
- "dangerous": potentially destructive or system-altering
For chained commands, classify based on the MOST risky operation in the chain.

--- NEGATIVE EXAMPLES (STRICTLY FORBIDDEN) ---
❌ In Git Bash, do NOT run: Get-CimInstance Win32_LogicalDisk
❌ In PowerShell, do NOT run: ls -la /mnt/c/
❌ In CMD, do NOT run: df -h
❌ In Git Bash, do NOT run: powershell.exe -Command "..."
❌ In PowerShell, do NOT run: bash -c "..."
Use ONLY the current shell's native syntax.`
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/stores/aiStore.ts
git commit -m "feat(ai): rewrite system prompt with new tools and decision tree"
```

---

### Task 10: Build Verification

**Files:**
- None (build only)

- [ ] **Step 1: Clean build the frontend**

```bash
cd frontend
rm -rf dist node_modules/.vite .vite
npm run build
```

Expected: Build succeeds with no TypeScript errors. Ignore existing warnings about chunk size and dynamic imports.

- [ ] **Step 2: Start the app**

```bash
cd ..
wails dev
```

- [ ] **Step 3: Smoke test**

1. Open AI sidebar, send "run pwd"
2. Verify AI uses `execute_command` with timeout parameter
3. Verify command output appears correctly
4. Send "start a simple http server: python -m http.server 9999"
5. Verify AI uses `start_command`, server starts, AI confirms
6. Send "cancel the http server"
7. Verify AI uses `interrupt_command`

- [ ] **Step 4: Commit any build fixes**

```bash
git add -A
git commit -m "chore: build verification after AI terminal tools feature"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ `execute_command` with timeout/head_lines/tail_lines — Task 2
- ✅ `start_command` — Task 3
- ✅ `capture_terminal` — Task 4
- ✅ `collect_output` (pure passive) — Task 5
- ✅ `send_terminal_key` with param validation — Task 6
- ✅ `interrupt_command` — Task 8 (reuses sendTerminalKey), Task 7 (tool def)
- ✅ Output truncation — Task 2 (truncateOutput helper)
- ✅ System prompt rewrite — Task 9
- ✅ watchOutput primitive — Task 1

**2. Placeholder scan:** No TBD, TODO, or vague instructions. All code is concrete and complete.

**3. Type consistency:**
- `watchOutput` signature → `{ promise: Promise<WatchResult>; cleanup: () => void }` — used in Task 2 and Task 6
- `executeCommand(command, timeoutMs, headLines, tailLines)` → imported in Task 8
- `startCommand(command)` → imported in Task 8
- `captureTerminal(headLines, tailLines)` → imported in Task 8
- `collectOutput(timeoutMs, headLines, tailLines)` → imported in Task 8
- `sendTerminalKey(input?, control?)` → imported in Task 8
- All tool input schemas (Task 7) match `tu.input` property accesses (Task 8)
