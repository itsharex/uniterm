# WSL 本地终端支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 uniTerm 的本地终端菜单中自动发现并列出 WSL 发行版，用户点击后可通过现有 `local` session 打开对应 WSL 终端。

**Architecture:** 后端新增 `ListWSLDistros()` 并通过 `wsl.exe -l -q` 扫描发行版；以 `wsl://<distro>` 伪路径把 WSL 注入现有 `GetAvailableShells()` 列表；Windows `LocalSession` 识别该前缀并启动 `wsl.exe -d <distro>`；前端侧边栏对 `wsl://` 项做特殊标签展示。

**Tech Stack:** Go (Wails v2), Vue 3 + TypeScript, Windows ConPTY, WSL CLI.

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `app.go` | 新增 `ListWSLDistros()` Wails 绑定；扩展 `GetAvailableShells()` 追加 WSL 发行版 |
| `app_test.go` | 对 `ListWSLDistros` 解析逻辑的单测 |
| `backend/session/local_session_windows.go` | 识别 `wsl://` 路径并启动 WSL；调整 `buildCommandLine`、`shellName` |
| `frontend/src/App.vue` | `getShellLabel()` 识别 `wsl://` 前缀 |
| `frontend/src/components/Sidebar.vue` | 本地终端子菜单中渲染 WSL 发行版并添加视觉区分 |
| `frontend/wailsjs/go/main/App.d.ts` / `App.js` | Wails 自动生成，新增 `ListWSLDistros()` 绑定 |

---

## Task 1: 后端新增 WSL 发行版扫描

**Files:**
- Modify: `app.go`
- Create: `app_test.go`

### Step 1: 在 `app.go` 中添加 `ListWSLDistros()` 与解析函数

在 `app.go` 中 `import` 块确保已有：

```go
"bytes"
"os/exec"
"runtime"
"strings"
```

（已有 `runtime` 用的是 `goruntime` 别名，注意避免冲突；下面用 `runtime` 作为包名时若已别名会冲突，建议直接复用现有 `goruntime` 或局部处理。）

在 `GetAvailableShells()` 上方添加以下代码：

```go
// ListWSLDistros returns the names of installed WSL distributions.
// On non-Windows platforms, or if WSL is not available, it returns an empty list.
func (a *App) ListWSLDistros() ([]string, error) {
	if goruntime.GOOS != "windows" {
		return nil, nil
	}
	return listWSLDistros()
}

func listWSLDistros() ([]string, error) {
	cmd := exec.Command("wsl.exe", "-l", "-q")
	out, err := cmd.Output()
	if err != nil {
		// WSL may not be installed/enabled; treat as empty list.
		return nil, nil
	}
	return parseWSLDistros(out), nil
}

func parseWSLDistros(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}

	// wsl.exe -l -q outputs UTF-16 LE with a BOM on many systems.
	content := string(raw)
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
		utf16le := make([]uint16, 0, len(raw)/2)
		for i := 2; i+1 < len(raw); i += 2 {
			utf16le = append(utf16le, uint16(raw[i])|uint16(raw[i+1])<<8)
		}
		content = string(utf16.Decode(utf16le))
	}

	var distros []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		// Remove null bytes and default-marker asterisk.
		line = strings.ReplaceAll(line, "\x00", "")
		line = strings.TrimSpace(strings.TrimPrefix(line, "*"))
		if line == "" {
			continue
		}
		// Skip internal/docker distros that are not useful as shells.
		lower := strings.ToLower(line)
		if strings.Contains(lower, "docker-desktop") {
			continue
		}
		if !seen[line] {
			seen[line] = true
			distros = append(distros, line)
		}
	}
	return distros
}
```

同时需要在 `app.go` 的 import 中添加：

```go
"unicode/utf16"
```

### Step 2: 在 `app_test.go` 中编写解析函数测试

```go
package main

import (
	"reflect"
	"testing"
)

func TestParseWSLDistros_UTF16LE(t *testing.T) {
	// UTF-16 LE BOM + "Ubuntu\n\x00Debian\n\x00" with interleaved nulls.
	raw := []byte{0xFF, 0xFE, 'U', 0, 'b', 0, 'u', 0, 'n', 0, 't', 0, 'u', 0, '\n', 0,
		'D', 0, 'e', 0, 'b', 0, 'i', 0, 'a', 0, 'n', 0, '\n', 0}
	got := parseWSLDistros(raw)
	want := []string{"Ubuntu", "Debian"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseWSLDistros() = %v, want %v", got, want)
	}
}

func TestParseWSLDistros_UTF8(t *testing.T) {
	raw := []byte("Ubuntu\n*Debian\n\ndocker-desktop-data\n")
	got := parseWSLDistros(raw)
	want := []string{"Ubuntu", "Debian"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseWSLDistros() = %v, want %v", got, want)
	}
}

func TestParseWSLDistros_Empty(t *testing.T) {
	got := parseWSLDistros(nil)
	if got != nil {
		t.Errorf("parseWSLDistros(nil) = %v, want nil", got)
	}
}
```

### Step 3: 运行测试

```bash
cd c:/Users/yowsa/Documents/workspace/uniterm
go test ./... -run TestParseWSLDistros -v
```

Expected: 三个测试全部 PASS。

### Step 4: （不提交 per 用户要求）

---

## Task 2: 扩展 `GetAvailableShells()` 以包含 WSL 发行版

**Files:**
- Modify: `app.go` 中的 `GetAvailableShells()`

### Step 1: 修改 `GetAvailableShells()`

在 Windows case 的末尾、return shells 之前追加：

```go
// Append installed WSL distributions as pseudo-shell paths.
if distros, _ := listWSLDistros(); len(distros) > 0 {
	for _, d := range distros {
		shells = append(shells, "wsl://"+d)
	}
}
```

完整 Windows case 应类似：

```go
case "windows":
	add("pwsh.exe")
	add("powershell.exe")
	add("cmd.exe")
	for _, p := range []string{
		`C:\Program Files\Git\bin\bash.exe`,
		`C:\Program Files (x86)\Git\bin\bash.exe`,
		`C:\ProgramData\chocolatey\bin\bash.exe`,
	} {
		add(p)
	}
	if !hasShell("bash.exe") {
		add("bash.exe")
	}
	// Append installed WSL distributions as pseudo-shell paths.
	if distros, _ := listWSLDistros(); len(distros) > 0 {
		for _, d := range distros {
			shells = append(shells, "wsl://"+d)
		}
	}
```

### Step 2: 手动验证

在已安装 WSL 的 Windows 机器上启动应用，打开侧边栏 `New Local Terminal` 子菜单，应看到类似：

- PowerShell
- Windows PowerShell
- Command Prompt
- Git Bash
- WSL - Ubuntu
- WSL - Debian

（在未安装 WSL 的机器上应无 WSL 条目。）

---

## Task 3: 修改 `LocalSession` 支持 `wsl://` 启动

**Files:**
- Modify: `backend/session/local_session_windows.go`

### Step 3.1: 添加 WSL 路径识别辅助函数

在 `buildCommandLine` 上方添加：

```go
func parseWSLPath(path string) (distro string, ok bool) {
	const prefix = "wsl://"
	if !strings.HasPrefix(strings.ToLower(path), prefix) {
		return "", false
	}
	return path[len(prefix):], true
}

func wslCommandLine(distro string) string {
	return fmt.Sprintf(`wsl.exe -d %s`, distro)
}
```

### Step 3.2: 修改 `Connect()`

在 `shell := config.ShellPath` 之后插入检测：

```go
func (s *LocalSession) Connect(config ConnectionConfig) error {
	s.setStatus(StatusConnecting)

	shell := config.ShellPath
	if shell == "" {
		shell = defaultShell()
	}

	// Handle WSL distribution pseudo-paths.
	if distro, ok := parseWSLPath(shell); ok {
		s.title = "WSL - " + distro
		return s.connectWSL(distro)
	}

	s.title = shellName(shell)

	// Try ConPTY first ...
```

### Step 3.3: 新增 `connectWSL()` 方法

在 `Connect()` 之后添加：

```go
func (s *LocalSession) connectWSL(distro string) error {
	cmdLine := wslCommandLine(distro)

	if conpty.IsConPtyAvailable() {
		cols, rows := s.GetPendingSize()
		if cols <= 0 || rows <= 0 {
			cols, rows = 80, 24
		}
		c, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(cols, rows))
		if err == nil {
			s.cpty = c
			go func() {
				_, _ = s.cpty.Wait(context.Background())
				s.Disconnect()
			}()
			s.setStatus(StatusConnected)
			go s.readLoop()
			return nil
		}
	}

	// Pipe fallback.
	s.cmd = exec.Command("wsl.exe", "-d", distro)
	s.cmd.Env = os.Environ()

	stdinPipe, err := s.cmd.StdinPipe()
	if err != nil {
		s.setStatus(StatusError)
		return fmt.Errorf("stdin pipe: %w", err)
	}
	stdoutPipe, err := s.cmd.StdoutPipe()
	if err != nil {
		s.setStatus(StatusError)
		return fmt.Errorf("stdout pipe: %w", err)
	}
	s.cmd.Stderr = s.cmd.Stdout

	if err := s.cmd.Start(); err != nil {
		s.setStatus(StatusError)
		return fmt.Errorf("start wsl: %w", err)
	}

	s.stdin = stdinPipe
	s.stdout = stdoutPipe

	go func() {
		_ = s.cmd.Wait()
		s.Disconnect()
	}()

	s.setStatus(StatusConnected)
	go s.readLoop()
	return nil
}
```

### Step 3.4: 调整 `buildCommandLine()`

保持原有逻辑，但开头增加 WSL 分支（即使当前 `connectWSL` 不走这里，也保证辅助函数一致）：

```go
func buildCommandLine(shell string) string {
	lower := strings.ToLower(shell)

	if distro, ok := parseWSLPath(shell); ok {
		return wslCommandLine(distro)
	}

	// existing logic ...
}
```

### Step 3.5: 调整 `shellName()`

```go
func shellName(path string) string {
	if distro, ok := parseWSLPath(path); ok {
		return "WSL - " + distro
	}
	base := filepath.Base(path)
	base = strings.TrimSuffix(base, ".exe")
	return base
}
```

### Step 3.6: 验证

在 Windows 上运行：

```bash
wails dev
```

点击 `WSL - Ubuntu` 应能打开 Ubuntu shell，输入 `lsb_release -a` 应显示 Ubuntu 信息。

---

## Task 4: 前端 `App.vue` 标签识别 `wsl://`

**Files:**
- Modify: `frontend/src/App.vue` 中的 `getShellLabel()`

### Step 1: 修改 `getShellLabel`

```ts
function getShellLabel(path: string): string {
  if (!path) return 'Local'
  const lower = path.toLowerCase()
  if (lower.startsWith('wsl://')) {
    const distro = path.slice(6)
    return `WSL - ${distro}`
  }
  if (lower.includes('pwsh')) return 'PowerShell'
  if (lower.includes('powershell')) return 'Windows PowerShell'
  if (lower.includes('bash')) return 'Git Bash'
  if (lower.includes('cmd')) return 'Command Prompt'
  return path.replace(/\\/g, '/').split('/').pop() || 'Local'
}
```

### Step 2: 验证

打开本地终端菜单，WSL 项应显示为 `WSL - Ubuntu`；打开后的 tab 标题也应为 `WSL - Ubuntu`。

---

## Task 5: 前端 `Sidebar.vue` 美化 WSL 菜单项

**Files:**
- Modify: `frontend/src/components/Sidebar.vue`

### Step 1: 修改 shell 子菜单渲染

找到 `<div class="shell-submenu">` 内的 `v-for`（约第 90-95 行），改为：

```vue
<div class="shell-submenu">
  <template v-for="sh in settingsStore.availableShells" :key="sh">
    <div v-if="sh.toLowerCase().startsWith('wsl://') && isFirstWSL(sh)" class="shell-group-label">
      WSL
    </div>
    <div class="shell-item" :class="{ 'wsl-item': sh.toLowerCase().startsWith('wsl://') }" @click="onShellSelect(sh)">
      {{ getShellLabel(sh) }}
    </div>
  </template>
</div>
```

在 `<script setup>` 中新增辅助函数：

```ts
function isFirstWSL(path: string): boolean {
  const idx = settingsStore.availableShells.findIndex(s => s.toLowerCase().startsWith('wsl://'))
  return settingsStore.availableShells[idx] === path
}
```

### Step 2: 添加样式

在 `Sidebar.vue` 的 `<style scoped>` 中找到 `.shell-item` 相关样式，添加：

```css
.shell-group-label {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-top: 1px solid var(--border-color);
  margin-top: 4px;
}

.wsl-item {
  padding-left: 20px;
}
```

若 CSS 变量不存在，使用现有颜色变量或硬编码为 `#888` 等。

### Step 3: 验证

启动后侧边栏本地终端子菜单应呈现分组效果：

```
PowerShell
Windows PowerShell
Command Prompt
Git Bash
-----------
WSL
  WSL - Ubuntu
  WSL - Debian
```

---

## Task 6: 重新生成 Wails 绑定

**Files:**
- Auto-generate: `frontend/wailsjs/go/main/App.d.ts`, `frontend/wailsjs/go/main/App.js`

### Step 1: 运行 Wails 绑定生成

```bash
cd c:/Users/yowsa/Documents/workspace/uniterm
wails generate module
```

或启动 dev server 让 Wails 自动同步绑定。

### Step 2: 验证

检查 `frontend/wailsjs/go/main/App.d.ts` 和 `App.js` 中是否出现 `ListWSLDistros`。

---

## Task 7: 完整构建与手动测试

### Step 1: 清理并构建前端

```bash
cd frontend
rm -rf dist node_modules/.vite .vite
npm run build
cd ..
```

### Step 2: 启动开发模式

```bash
wails dev
```

### Step 3: 手动测试清单

- [ ] 侧边栏 `New Local Terminal` 菜单中正确列出 WSL 发行版。
- [ ] 点击 WSL 发行版后打开对应 Linux shell。
- [ ] 在 WSL 终端中执行 `lsb_release -a` 验证发行版正确。
- [ ] tab 标题显示为 `WSL - <distro>`。
- [ ] 关闭 tab 后进程正常退出，无残留 `wsl.exe`。
- [ ] 调整终端窗口大小，WSL 终端输出正常换行。
- [ ] 在未安装 WSL 的 Windows 环境（或把 `wsl.exe` 临时重命名）下启动，菜单中不显示 WSL 条目，其他本地终端不受影响。

---

## 自检

### Spec coverage

| Spec 要求 | 对应任务 |
|-----------|----------|
| 后端新增 `ListWSLDistros()` | Task 1 |
| `wsl.exe -l -q` 扫描并清理输出 | Task 1 |
| 非 Windows / 无 WSL 返回空列表 | Task 1 |
| `LocalSession` 识别 `wsl://` 并启动 `wsl.exe -d` | Task 3 |
| 扩展 `GetAvailableShells()` | Task 2 |
| 前端展示 `WSL - <distro>` | Task 4, Task 5 |
| 不持久化到 connection store | 未引入保存逻辑，天然满足 |

### Placeholder scan

计划中无 TBD/TODO，每个步骤包含可执行代码与验证命令。

### Type consistency

- 辅助函数名：`parseWSLPath`、`listWSLDistros`、`parseWSLDistros` 全计划一致。
- 伪路径前缀：`wsl://` 在前后端一致使用。
- Wails 绑定：`ListWSLDistros` 返回 `[]string` 与 `[]string` 一致。

---

## 执行方式

计划已保存到 `.superpowers/plans/2026-06-20-wsl-local-terminal.md`。

**两种执行方式：**

1. **Subagent-Driven（推荐）** — 每个 Task 派一个子代理执行，我在每个 Task 后检查，迭代快。
2. **Inline Execution** — 在当前会话中按 Task 顺序执行，使用 `superpowers:executing-plans` 批量推进。

你希望用哪种方式？另外，是否现在就开始执行第一个 Task？
