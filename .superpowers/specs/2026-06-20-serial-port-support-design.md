# Serial Port Support — Design Spec

**Date:** 2026-06-20  
**Branch:** `feature/serial-port-support`

## Overview

Add serial port (RS-232 / USB-serial) terminal support to uniTerm, enabling users to connect to embedded devices, network equipment console ports, and other serial-interfaced hardware.

The feature follows a **quick-connect** model: no persistent configuration, zero-click setup after the dialog.

## Entry Point

- Add **"Serial"** item in the existing "New" button dropdown menu (alongside SSH, Telnet, Mosh, etc.)
- Category: a one-off quick connection, not a saved session

## Connection Flow

```
User clicks "Serial" in dropdown
  → SerialConnectDialog opens (modal)
    ├── Port selector: auto-scanned list of available serial ports
    │   (Windows: COM1, COM3, ...; Unix: /dev/ttyUSB0, /dev/ttyS0, ...)
    ├── Baud rate: dropdown (preset list) + editable text field
    │   Presets: 300, 1200, 2400, 4800, 9600, 14400, 19200, 38400,
    │            57600, 115200, 230400, 460800, 921600
    ├── Data bits: dropdown (5, 6, 7, 8) — default 8
    ├── Stop bits: dropdown (1, 1.5, 2) — default 1
    ├── Parity: dropdown (None, Odd, Even, Mark, Space) — default None
    ├── Flow control: dropdown (None, Hardware/RTS-CTS, Software/XON-XOFF) — default None
    └── [Connect] button
  → Backend creates a serial Session, opens a terminal tab
  → Standard terminal interaction (input/output in xterm.js)
```

## No Persistence

- Serial connections are NOT saved to `connections.json`
- No sidebar entry is created
- The dialog defaults to most-recently-used port and parameters within the session lifetime
- Closing the tab disconnects and discards the session

## Terminal Behavior

- Reuses existing xterm.js rendering (identical to SSH/Telnet tabs)
- Full keyboard input, copy/paste, search, context menu
- Resize behavior: serial sessions are not resizable in the traditional sense; handle gracefully (no-op or buffer resize only)
- Disconnect: closes the serial port, removes the tab

## Implementation Plan

### Backend (Go)

1. **New dependency**: `go.bug.st/serial` (cross-platform serial port library)
2. **New file**: `backend/session/serial_session.go`
   - Implements the `Session` interface
   - Opens/closes serial port via the serial library
   - Reads from serial port in a goroutine, forwarding data via `OnDataCallback`
   - Writes by sending bytes to the serial port
3. **Modified**: `backend/session/manager.go`
   - Add `"serial"` case to `Create()` factory
4. **New API**: `ListSerialPorts()` — returns available serial port names
5. **New API**: `ConnectSerial(port string, baudRate int, dataBits int, stopBits float64, parity string, flowControl string) -> sessionId`  
   Or reuse `CreateSession("serial", config)` with extended `ConnectionConfig`

### Frontend (Vue/TS)

1. **New component**: `frontend/src/components/SerialConnectDialog.vue`
   - Port dropdown (populated from `ListSerialPorts()` on open)
   - Parameter fields with defaults
   - Connect button
2. **Modified**: New dropdown menu — add "Serial" entry
3. **New types**: `SerialConfig` interface in `frontend/src/types/`

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| No persistence | Serial ports are ephemeral (USB ports change); saving configs creates stale entries |
| Dropdown menu entry | Consistent with existing "New" connection UX; serial is a first-class connection type |
| Dedicated dialog | Serial has different parameters from SSH/Telnet; clean separation avoids cramming into ConnectionForm |
| Reuse Session interface | Leverages existing terminal integration, status events, lifecycle management |
| `go.bug.st/serial` | Mature, cross-platform, pure Go; avoids cgo complexity |

## Scope

### In scope
- Serial port list scanning
- Standard serial parameters (baud, data bits, stop bits, parity, flow control)
- Interactive terminal over serial
- Disconnect handling

### Out of scope (future)
- Saving serial connection profiles
- Hex dump / binary display mode
- Break signal / DTR-RTS toggle controls
- File transfer over serial (XMODEM/YMODEM/ZMODEM — Zmodem already supported via terminal)
- Serial port monitoring/logging to file
