# Serial Port Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add serial port terminal support to uniTerm — quick-connect via "New" dropdown, no persistence.

**Architecture:** New `SerialSession` in Go implements the existing `Session` interface using `go.bug.st/serial`. A dedicated `ConnectSerial` API bypasses `ConnectionConfig` bloat. A new Vue dialog (`SerialConnectDialog`) handles port selection and parameter config. Terminal rendering reuses existing xterm.js pipeline unchanged.

**Tech Stack:** Go 1.26, `go.bug.st/serial`, Vue 3 + Element Plus + xterm.js

---

### Task 1: Add Go serial port dependency

**Files:**
- Modify: `go.mod` (via `go get`)

- [ ] **Step 1: Add `go.bug.st/serial` dependency**

Run:
```bash
cd backend && go get go.bug.st/serial
```

Expected: `go.mod` updated with new require line.

- [ ] **Step 2: Verify `go mod tidy`**

Run:
```bash
cd backend && go mod tidy
```

Expected: Clean exit, no errors.

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add go.bug.st/serial dependency"
```

---

### Task 2: Create SerialSession backend

**Files:**
- Create: `backend/session/serial_session.go`

- [ ] **Step 1: Write `serial_session.go`**

```go
package session

import (
	"fmt"
	"io"
	"sync"

	"go.bug.st/serial"
)

// SerialConfig holds serial port connection parameters.
type SerialConfig struct {
	PortName    string
	BaudRate    int
	DataBits    int
	StopBits    serial.StopBits
	Parity      serial.Parity
	FlowControl serial.FlowControl
}

type SerialSession struct {
	baseSession
	port   serial.Port
	config SerialConfig
	quit   chan struct{}
	quitOnce sync.Once
}

func NewSerialSession(id string) *SerialSession {
	return &SerialSession{
		baseSession: baseSession{
			id:          id,
			sessionType: "serial",
			status:      StatusDisconnected,
		},
		quit: make(chan struct{}),
	}
}

func (s *SerialSession) Connect(config ConnectionConfig) error {
	// Serial sessions ignore ConnectionConfig fields; they receive
	// their real config via SetSerialConfig before Connect is called.
	s.setStatus(StatusConnecting)
	s.title = fmt.Sprintf("%s @ %d baud", s.config.PortName, s.config.BaudRate)

	mode := &serial.Mode{
		BaudRate:    s.config.BaudRate,
		DataBits:    s.config.DataBits,
		StopBits:    s.config.StopBits,
		Parity:      s.config.Parity,
		FlowControl: s.config.FlowControl,
	}

	port, err := serial.Open(s.config.PortName, mode)
	if err != nil {
		s.setStatus(StatusError)
		return fmt.Errorf("serial open %s: %w", s.config.PortName, err)
	}
	s.port = port
	s.setStatus(StatusConnected)

	go s.readLoop()
	return nil
}

func (s *SerialSession) SetSerialConfig(cfg SerialConfig) {
	s.config = cfg
}

func (s *SerialSession) readLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := s.port.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if s.IsZmodemMode() {
				s.emitBinary(data)
			} else if looksLikeZmodemHeader(data) {
				s.SetZmodemMode(true)
				s.emitBinary(data)
			} else {
				s.emitData(data)
			}
		}
		if err != nil {
			if err != io.EOF {
				s.emitData([]byte(fmt.Sprintf("\r\n\x1b[31m[Serial read error: %v]\x1b[0m\r\n", err)))
			}
			s.Disconnect()
			return
		}
	}
}

func (s *SerialSession) Write(data []byte) error {
	if s.port == nil {
		return fmt.Errorf("serial port not connected")
	}
	_, err := s.port.Write(data)
	return err
}

func (s *SerialSession) Disconnect() error {
	s.quitOnce.Do(func() {
		close(s.quit)
		if s.port != nil {
			s.port.Close()
			s.port = nil
		}
		s.setStatus(StatusDisconnected)
	})
	return nil
}

func (s *SerialSession) Resize(cols, rows int) error {
	// Serial sessions don't support terminal resize in the SSH sense.
	// Store pending size for consistency but it's a no-op.
	s.SetPendingSize(cols, rows)
	return nil
}

func (s *SerialSession) IsConnected() bool {
	return s.Status() == StatusConnected
}

// ListSerialPorts returns the names of available serial ports.
func ListSerialPorts() ([]string, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}
	names := make([]string, len(ports))
	for i, p := range ports {
		names[i] = p
	}
	return names, nil
}
```

- [ ] **Step 2: Verify compilation**

Run:
```bash
cd backend && go build ./...
```

Expected: No compile errors.

- [ ] **Step 3: Commit**

```bash
git add backend/session/serial_session.go
git commit -m "feat: add SerialSession backend with serial port I/O"
```

---

### Task 3: Register "serial" in SessionManager

**Files:**
- Modify: `backend/session/manager.go:28-58`

- [ ] **Step 1: Add `"serial"` case to `Create()` factory**

At [manager.go:57](backend/session/manager.go#L57) (after the `"ftp"` case), add:

```go
case "serial":
    s = NewSerialSession(config.ID)
```

- [ ] **Step 2: Verify compilation**

Run:
```bash
cd backend && go build ./...
```

Expected: No compile errors.

- [ ] **Step 3: Commit**

```bash
git add backend/session/manager.go
git commit -m "feat: register serial session type in SessionManager"
```

---

### Task 4: Add ListSerialPorts and ConnectSerial to App

**Files:**
- Modify: `app.go`

- [ ] **Step 1: Add `ListSerialPorts` Wails binding**

Add this method to `App` in `app.go` (after `GetDefaultShell`, around line 1443):

```go
// ListSerialPorts returns available serial port names.
func (a *App) ListSerialPorts() ([]string, error) {
	return session.ListSerialPorts()
}
```

- [ ] **Step 2: Add `ConnectSerial` Wails binding**

Add after `ListSerialPorts`:

```go
// ConnectSerial creates a new serial session and connects asynchronously.
// It returns the session info immediately; data flows via session:data events.
func (a *App) ConnectSerial(portName string, baudRate int, dataBits int, stopBits float64, parity string, flowControl string) (*session.SessionInfo, error) {
	if a.sessionManager == nil {
		return nil, fmt.Errorf("session manager not initialized")
	}

	// Map JS-friendly strings to serial library constants
	var sb serial.StopBits
	switch stopBits {
	case 1.5:
		sb = serial.OnePointFiveStopBits
	case 2:
		sb = serial.TwoStopBits
	default:
		sb = serial.OneStopBit
	}

	parityMap := map[string]serial.Parity{
		"none":  serial.NoParity,
		"odd":   serial.OddParity,
		"even":  serial.EvenParity,
		"mark":  serial.MarkParity,
		"space": serial.SpaceParity,
	}
	par, ok := parityMap[strings.ToLower(parity)]
	if !ok {
		par = serial.NoParity
	}

	var fc serial.FlowControl
	switch strings.ToLower(flowControl) {
	case "hardware", "rts-cts":
		fc = serial.FlowControlHardware
	case "software", "xon-xoff":
		fc = serial.FlowControlSoftware
	default:
		fc = serial.NoFlowControl
	}

	serialCfg := session.SerialConfig{
		PortName:    portName,
		BaudRate:    baudRate,
		DataBits:    dataBits,
		StopBits:    sb,
		Parity:      par,
		FlowControl: fc,
	}

	config := session.ConnectionConfig{
		Name: fmt.Sprintf("%s (%d)", portName, baudRate),
		Type: "serial",
	}

	s, err := a.sessionManager.Create("serial", config)
	if err != nil {
		return nil, err
	}

	serSess, ok := s.(*session.SerialSession)
	if !ok {
		_ = a.sessionManager.Close(s.ID())
		return nil, fmt.Errorf("internal error: session is not SerialSession")
	}
	serSess.SetSerialConfig(serialCfg)

	// Wire callbacks (same pattern as CreateSession)
	s.SetOnDataCallback(func(data []byte) {
		runtime.EventsEmit(a.ctx, "session:data", map[string]interface{}{
			"id":   s.ID(),
			"data": string(data),
		})
	})
	s.SetOnBinaryCallback(func(data []byte) {
		runtime.EventsEmit(a.ctx, "session:binary", map[string]interface{}{
			"id":   s.ID(),
			"data": base64.StdEncoding.EncodeToString(data),
		})
	})
	s.SetOnStatusChangeCallback(func(status session.SessionStatus) {
		runtime.EventsEmit(a.ctx, "session:status", map[string]interface{}{
			"id":     s.ID(),
			"status": status,
		})
	})

	// Connect asynchronously
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Writef("serial session %s connect panic: %v\n%s", s.ID(), r, string(debug.Stack()))
			}
		}()
		if err := s.Connect(config); err != nil {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "session:data", map[string]interface{}{
					"id":   s.ID(),
					"data": fmt.Sprintf("\r\n\x1b[31m[Serial connection failed: %v]\x1b[0m\r\n", err),
				})
			}
			_ = a.sessionManager.Close(s.ID())
		}
	}()

	return &session.SessionInfo{
		ID:     s.ID(),
		Type:   s.Type(),
		Title:  s.Title(),
		Status: s.Status(),
	}, nil
}
```

You'll need to add these imports to the existing import block in `app.go`:
- `"strings"` — already imported
- `"go.bug.st/serial"` — new
- `session` package is already imported

- [ ] **Step 3: Verify compilation**

Run:
```bash
cd backend && go build ./...
```

Expected: No compile errors.

- [ ] **Step 4: Commit**

```bash
git add app.go
git commit -m "feat: add ListSerialPorts and ConnectSerial Wails bindings"
```

---

### Task 5: Regenerate Wails bindings

**Files:**
- Auto-generated: `frontend/src/wailsjs/go/main/App.js` and `App.d.ts`

- [ ] **Step 1: Run `wails dev` briefly to regenerate bindings**

Run:
```bash
wails dev
```

Wait for the frontend dev server to start and the Wails bindings to regenerate (watch for `frontend/src/wailsjs/go/main/App.js` to update). Then stop with `Ctrl+C`.

Alternatively, if `wails generate module` works:

```bash
wails generate module
```

- [ ] **Step 2: Verify generated bindings contain new methods**

Check that `frontend/wailsjs/go/main/App.js` includes `ListSerialPorts` and `ConnectSerial`.

- [ ] **Step 3: Commit**

```bash
git add frontend/wailsjs/
git commit -m "chore: regenerate Wails bindings for serial APIs"
```

---

### Task 6: Add i18n strings for serial

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/zh-CN.json`

- [ ] **Step 1: Add English strings**

In `en.json`, add at an appropriate location (near other connection-type strings):

```json
"serial.title": "Serial",
"serial.portLabel": "Port",
"serial.baudRate": "Baud Rate",
"serial.dataBits": "Data Bits",
"serial.stopBits": "Stop Bits",
"serial.parity": "Parity",
"serial.flowControl": "Flow Control",
"serial.connect": "Connect",
"serial.noPorts": "No serial ports detected",
"serial.scanning": "Scanning...",
"serial.parityNone": "None",
"serial.parityOdd": "Odd",
"serial.parityEven": "Even",
"serial.parityMark": "Mark",
"serial.paritySpace": "Space",
"serial.flowNone": "None",
"serial.flowHardware": "Hardware (RTS/CTS)",
"serial.flowSoftware": "Software (XON/XOFF)",
"sidebar.connectSerial": "Serial"
```

- [ ] **Step 2: Add Chinese strings**

In `zh-CN.json`, add:

```json
"serial.title": "串口",
"serial.portLabel": "端口",
"serial.baudRate": "波特率",
"serial.dataBits": "数据位",
"serial.stopBits": "停止位",
"serial.parity": "校验位",
"serial.flowControl": "流控",
"serial.connect": "连接",
"serial.noPorts": "未检测到串口设备",
"serial.scanning": "扫描中...",
"serial.parityNone": "无",
"serial.parityOdd": "奇校验",
"serial.parityEven": "偶校验",
"serial.parityMark": "标记",
"serial.paritySpace": "空格",
"serial.flowNone": "无",
"serial.flowHardware": "硬件 (RTS/CTS)",
"serial.flowSoftware": "软件 (XON/XOFF)",
"sidebar.connectSerial": "串口"
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/i18n/locales/en.json frontend/src/i18n/locales/zh-CN.json
git commit -m "feat: add i18n strings for serial port dialog"
```

---

### Task 7: Create SerialConnectDialog component

**Files:**
- Create: `frontend/src/components/SerialConnectDialog.vue`

- [ ] **Step 1: Write the dialog component**

```vue
<template>
  <el-dialog v-model="visible" :title="t('serial.title')" width="420px" @open="onOpen">
    <el-form label-width="110px" @submit.prevent="onConnect">
      <el-form-item :label="t('serial.portLabel')">
        <el-select v-model="portName" :placeholder="portsLoading ? t('serial.scanning') : t('serial.noPorts')" :disabled="portsLoading || ports.length === 0" style="width:100%">
          <el-option v-for="p in ports" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('serial.baudRate')">
        <el-select v-model="baudRate" filterable allow-create default-first-option style="width:100%">
          <el-option v-for="b in baudRatePresets" :key="b" :label="String(b)" :value="b" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('serial.dataBits')">
        <el-select v-model="dataBits" style="width:100%">
          <el-option v-for="d in [5,6,7,8]" :key="d" :label="String(d)" :value="d" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('serial.stopBits')">
        <el-select v-model="stopBits" style="width:100%">
          <el-option v-for="s in [1, 1.5, 2]" :key="s" :label="String(s)" :value="s" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('serial.parity')">
        <el-select v-model="parity" style="width:100%">
          <el-option v-for="p in parityOptions" :key="p.value" :label="p.label" :value="p.value" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('serial.flowControl')">
        <el-select v-model="flowControl" style="width:100%">
          <el-option v-for="f in flowOptions" :key="f.value" :label="f.label" :value="f.value" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">{{ t('conn.cancel') }}</el-button>
      <el-button type="primary" :disabled="!portName" @click="onConnect" :loading="connecting">
        {{ t('serial.connect') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ListSerialPorts, ConnectSerial } from '../../wailsjs/go/main/App'
import { useI18n } from '../i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'connect': [sessionId: string, portName: string, baudRate: number]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const baudRatePresets = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

const parityOptions = [
  { value: 'none', label: t('serial.parityNone') },
  { value: 'odd', label: t('serial.parityOdd') },
  { value: 'even', label: t('serial.parityEven') },
  { value: 'mark', label: t('serial.parityMark') },
  { value: 'space', label: t('serial.paritySpace') },
]

const flowOptions = [
  { value: 'none', label: t('serial.flowNone') },
  { value: 'hardware', label: t('serial.flowHardware') },
  { value: 'software', label: t('serial.flowSoftware') },
]

const ports = ref<string[]>([])
const portsLoading = ref(false)
const portName = ref('')
const baudRate = ref(115200)
const dataBits = ref(8)
const stopBits = ref(1)
const parity = ref('none')
const flowControl = ref('none')
const connecting = ref(false)

async function onOpen() {
  portsLoading.value = true
  try {
    ports.value = await ListSerialPorts()
    if (ports.value.length > 0 && !portName.value) {
      portName.value = ports.value[0]
    }
  } catch (e) {
    console.error('ListSerialPorts failed:', e)
    ports.value = []
  } finally {
    portsLoading.value = false
  }
}

async function onConnect() {
  if (!portName.value) return
  connecting.value = true
  try {
    const info = await ConnectSerial(portName.value, baudRate.value, dataBits.value, stopBits.value, parity.value, flowControl.value)
    emit('connect', info.id, portName.value, baudRate.value)
    visible.value = false
  } catch (e: any) {
    console.error('ConnectSerial failed:', e)
  } finally {
    connecting.value = false
  }
}
</script>
```

- [ ] **Step 2: Verify compilation**

Run:
```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -20
```

Fix any type errors that appear.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/SerialConnectDialog.vue
git commit -m "feat: add SerialConnectDialog Vue component"
```

---

### Task 8: Add "Serial" to Sidebar new-connection dropdown

**Files:**
- Modify: `frontend/src/components/Sidebar.vue`

- [ ] **Step 1: Add "Serial" item to dropdown menu**

In the `<el-dropdown-menu>` block (around line 74-78), add a new item before the divider:

```html
<el-dropdown-item command="new-serial">{{ t('sidebar.connectSerial') }}</el-dropdown-item>
```

Place it between the Local Terminal submenu (lines 66-74) and the existing "New Connection" item (line 75).

- [ ] **Step 2: Handle the command in `onNewConnCommand`**

In the `onNewConnCommand` function (line 1125), add:

```typescript
} else if (cmd === 'new-serial') {
  emit('connectSerial')
}
```

- [ ] **Step 3: Add the emit declaration**

In the `defineEmits` block (line 395), add `'connectSerial'` to the emits array:

```typescript
const emit = defineEmits(['connect', 'connectSftp', 'connectFtp', 'connectRdp', 'connectVnc', 'connectSpice', 'connectDB', 'connectMonitor', 'toggle', 'new-local-terminal-with-shell', 'connectSerial'])
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar.vue
git commit -m "feat: add Serial entry to new-connection dropdown"
```

---

### Task 9: Wire serial connect in App.vue

**Files:**
- Modify: `frontend/src/App.vue`

- [ ] **Step 1: Import SerialConnectDialog**

Add import near other component imports (line 95 area):

```typescript
import SerialConnectDialog from './components/SerialConnectDialog.vue'
```

- [ ] **Step 2: Add reactive state**

Add after `showConnectionForm`:

```typescript
const showSerialDialog = ref(false)
```

- [ ] **Step 3: Add event handler for `onConnectSerial`**

Add after the existing `onConnect` handlers:

```typescript
async function onConnectSerial(sessionId: string, portName: string, baudRate: number) {
  const config: ConnectionConfig = {
    id: '',
    name: `${portName} (${baudRate})`,
    type: 'serial' as any,
    host: portName,
    port: baudRate,
    user: '',
    authType: 'password' as any,
  }
  const panel = panelStore.createPanel(config, 'serial')
  panel.title = `${portName} (${baudRate})`
  panelStore.bindSession(panel.id, sessionId)
  sessionStore.initSession(sessionId)
  const tab = tabStore.createTerminalTab(panel.title, panel.id)
  panelStore.movePanelToTab(panel.id, tab.id)
}
```

- [ ] **Step 4: Bind Sidebar `@connect-serial` event**

In the template, add to the `<Sidebar>` component (line 12):

```html
@connect-serial="showSerialDialog = true"
```

- [ ] **Step 5: Add SerialConnectDialog to template**

Add after `<ConnectionForm>` (line 73):

```html
<SerialConnectDialog v-model="showSerialDialog" @connect="onConnectSerial" />
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.vue
git commit -m "feat: wire serial connect flow in App.vue"
```

---

### Task 10: Build and verify

- [ ] **Step 1: Build frontend**

Run:
```bash
cd frontend && rm -rf dist node_modules/.vite .vite && npm run build
```

Expected: Build succeeds without errors.

- [ ] **Step 2: Start dev server and test**

Run:
```bash
cd .. && wails dev
```

Manual tests:
1. Click "New" dropdown → verify "Serial" item appears
2. Click "Serial" → verify dialog opens with available ports listed
3. Select a port, configure parameters, click Connect
4. Verify terminal tab opens with serial connection active
5. Type in the terminal → verify data is sent
6. Verify serial device output appears in terminal
7. Close tab → verify serial port disconnects cleanly

- [ ] **Step 3: Commit any remaining changes**

```bash
git commit -m "chore: final adjustments after serial feature verification"
```
