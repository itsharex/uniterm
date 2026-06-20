# WSL 本地终端支持设计文档

## 背景与目标

在 uniTerm 现有的本地终端体系中，用户通过侧边栏 `New Local Terminal` 子菜单选择 cmd、PowerShell、Git Bash 等 shell 打开一个临时本地终端。该列表由后端动态扫描系统可用 shell 得到，**不会持久化到 connection store**。

本设计的目标是在不新增独立会话类型的前提下，把 **WSL（Windows Subsystem for Linux）已安装发行版** 也纳入这套本地终端菜单，让用户可以直接选择 `WSL - Ubuntu`、`WSL - Debian` 等条目打开 WSL 终端。

## 设计原则

- **复用现有本地终端架构**：WSL 通过 `local` 会话类型承载，不重造 session。
- **最小侵入性**：尽量不动 `ConnectionConfig` 等通用结构，使用现有 `shellPath` 字段承载 WSL 特殊标识。
- **动态发现，不持久化**：和现有本地终端保持一致，WSL 发行版列表在启动时扫描，不进入 connections.json。

## 架构方案

采用 **扩展 `LocalSession` + `wsl://<distro>` 伪路径方案**。

### 1. 后端新增 WSL 扫描能力

在 `app.go` 新增 Wails 绑定：

```go
func (a *App) ListWSLDistros() ([]string, error)
```

实现方式：

```bash
wsl.exe -l -q
```

- 该命令输出每个发行版一行，可能带有 UTF-16 LE BOM（PowerShell 常见）和尾部 `\0`，需要清理。
- 去掉空行、默认发行版标记（`*`）以及不可用的发行版标记（如 `docker-desktop-data` 等内部发行版可过滤）。
- 返回例如 `["Ubuntu", "Debian"]`。
- 若系统未启用 WSL 或 `wsl.exe` 不存在，返回空列表且不报错。

### 2. 修改 `LocalSession` 以支持 WSL 启动

文件：`backend/session/local_session_windows.go`

- 在 `Connect()` 中检测 `config.ShellPath` 是否以 `wsl://` 开头。
- 提取发行版名称，实际执行命令为：

```go
exec.Command("wsl.exe", "-d", distro)
```

- 同时调整 `buildCommandLine()`：
  - 若 shell 以 `wsl://` 开头，返回 `"wsl.exe" -d <distro>`。
- 保持现有 ConPTY 优先逻辑，`wsl.exe` 在 ConPTY 下工作良好。
- 标题处理：`shellName()` 遇到 `wsl://Ubuntu` 时返回 `WSL - Ubuntu` 或 `Ubuntu`。

### 3. 扩展可用 shell 列表

文件：`app.go` 中的 `GetAvailableShells()`

- 在 Windows 平台扫描完普通 shell 后，调用内部函数获取 WSL 发行版。
- 对每个发行版，以 `wsl://<distro>` 格式追加到返回列表。
- 为保持向后兼容，普通 shell 路径保持不变。

### 4. 前端展示与交互

文件：`frontend/src/components/Sidebar.vue`

- `settingsStore.availableShells` 中已经包含 `wsl://Ubuntu` 这类条目。
- 在子菜单渲染时，对 `wsl://` 前缀做特殊展示：
  - 显示为 `WSL - Ubuntu`。
  - 可加小图标或分隔线与普通 shell 区分。
- 点击后触发 `new-local-terminal-with-shell`，传入 `wsl://Ubuntu`，复用现有 `createLocalTerminalWithShell` 流程。

文件：`frontend/src/App.vue`

- 调整 `getShellLabel()`：
  - 识别 `wsl://` 前缀，返回 `WSL - <distro>`。
- 其余逻辑（`createLocalTerminal`）无需改动。

### 5. 错误处理

- `wsl.exe` 不存在：返回空列表，前端不显示 WSL 菜单。
- `wsl.exe -l -q` 执行失败或返回非预期格式：优雅返回空列表，不阻断普通 shell 显示。
- 连接时 WSL 发行版不可用：由 `exec.Command` / ConPTY 启动失败给出错误状态，前端显示错误信息。
- 非 Windows 平台：直接返回空列表，不暴露 WSL 相关逻辑。

## 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `app.go` | 新增 `ListWSLDistros()`；扩展 `GetAvailableShells()` 追加 WSL 发行版 |
| `backend/session/local_session_windows.go` | 识别 `wsl://` 并启动 `wsl.exe -d <distro>`；调整 `buildCommandLine`、`shellName` |
| `frontend/src/components/Sidebar.vue` | 渲染 `wsl://` 项为 `WSL - <distro>`，可加图标/分隔 |
| `frontend/src/App.vue` | `getShellLabel()` 识别 `wsl://` |
| `frontend/wailsjs/go/main/App.d.ts` / `App.js` | Wails 自动生成，新增 `ListWSLDistros()` 绑定 |
| `frontend/src/i18n/locales/*.json` | 如需要，增加 `WSL` 相关 i18n 字符串 |

## 测试要点

- 在已安装 WSL 的 Windows 上，启动后侧边栏应看到普通 shell 与 WSL 发行版并列。
- 点击 WSL 发行版能正常打开 Linux shell，可执行 `lsb_release -a` 验证发行版正确。
- 在未安装 WSL 的 Windows 上，不显示 WSL 菜单，应用行为与之前一致。
- 关闭 WSL 终端面板后，session 正确断开，无进程残留。
- 调整终端大小对 WSL 会话生效（通过 ConPTY）。

## 不做的范围

- 不新增独立的 `wsl` 会话类型。
- 不把 WSL 发行版保存为 connection store 中的可持久化连接。
- 不支持 WSL 远程服务器 / WSL over SSH 等高级场景。
- 不处理 WSL 启动参数自定义（如 `--user`、`--exec` 等）。

## 后续可扩展

- 若未来需要保存“Ubuntu on WSL”这类连接，可在 `ConnectionConfig` 增加 `WslDistro` 字段并走保存流程。
- 可在设置中提供“是否显示 WSL 发行版”开关。
