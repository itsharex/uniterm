/**
 * terminalRecorder.ts — 前端终端录制服务（asciinema cast v2）
 *
 * 与 backend/recorder/recorder.go 通过 Wails binding 通信：
 *   - start(sessionId, width, height) → RecorderStart → 返回 cast 文件路径
 *   - writeData(data)                  → RecorderWriteData（带 elapsed 时间戳）
 *   - stop()                           → RecorderStop
 *
 * 设计要点：
 *   - 每个 BaseTerminal 实例持有一个 TerminalRecorder，sessionId 维度独立。
 *   - writeData 走独立写入队列（异步串行），不阻塞终端 rAF 渲染主路径。
 *   - 录制写入原始 session:data（未经 sanitize/highlight），保证回放忠实。
 *   - stop() 等待队列排空再调用 RecorderStop，避免丢尾数据。
 */

import {
  RecorderStart,
  RecorderWriteData,
  RecorderStop,
  RecorderIsRecording,
} from '../../bindings/github.com/ys-ll/uniterm/app'

export interface RecordingMeta {
  filePath: string
  fileName: string
  sessionId: string
  startTime: number // unix seconds
  duration: number // seconds
  size: number // bytes
}

export class TerminalRecorder {
  private sessionId: string | null = null
  private filePath: string | null = null
  private recording = false
  /** 写入队列：串行 await，避免并发 RecorderWriteData 打乱时序。 */
  private writeQueue: Promise<void> = Promise.resolve()
  /** 累计写入字节数（粗略，用于分段提示）。 */
  private bytesWritten = 0

  /** 当前是否正在录制。 */
  isRecording(): boolean {
    return this.recording
  }

  /** 当前录制文件路径（录制中有效）。 */
  getFilePath(): string | null {
    return this.filePath
  }

  /** 当前录制的 session id（录制中有效）。 */
  getSessionId(): string | null {
    return this.sessionId
  }

  /** 已写入字节数（粗略估算）。 */
  getBytesWritten(): number {
    return this.bytesWritten
  }

  /**
   * 开始录制。创建 cast 文件并写入 header。
   * @param sessionId 终端 session id
   * @param width     终端列数
   * @param height    终端行数
   */
  async start(sessionId: string, width: number, height: number): Promise<string> {
    if (this.recording) {
      // 已在录制：返回当前文件路径，不重复创建。
      return this.filePath || ''
    }
    if (!sessionId) {
      throw new Error('terminalRecorder: empty sessionId')
    }
    const path = await RecorderStart(sessionId, width || 80, height || 24)
    this.sessionId = sessionId
    this.filePath = path
    this.recording = true
    this.bytesWritten = 0
    return path
  }

  /**
   * 写入一帧终端输出数据。串行排队，不阻塞调用方。
   * 调用方应在 session:data hook 中同步调用，无需 await。
   */
  writeData(data: string): void {
    if (!this.recording || !this.filePath || !data) return
    const path = this.filePath
    // 累计字节（UTF-16 → 估长，足够分段提示用）。
    this.bytesWritten += data.length
    // 串行排队：每个 write 等 binding 返回后再发下一个。
    this.writeQueue = this.writeQueue
      .then(() => RecorderWriteData(path, data))
      .catch((err) => {
        // 单帧写入失败不中断录制（可能因窗口隐藏/IPC 抖动）。
        console.warn('[terminalRecorder] writeData failed:', err)
      })
  }

  /**
   * 停止录制。等待写入队列排空后关闭文件，返回文件路径。
   */
  async stop(): Promise<string> {
    if (!this.recording) {
      return this.filePath || ''
    }
    const path = this.filePath
    // 等待所有排队写入完成，再关闭文件，避免丢尾。
    try {
      await this.writeQueue
    } catch {
      // writeQueue 内已 catch，不会 reject；保险。
    }
    if (path) {
      try {
        await RecorderStop(path)
      } catch (err) {
        console.warn('[terminalRecorder] stop failed:', err)
      }
    }
    this.recording = false
    const ret = this.filePath
    this.filePath = null
    this.sessionId = null
    return ret || ''
  }

  /** 查询后端该路径是否仍在录制（调试用）。 */
  async checkBackendRecording(): Promise<boolean> {
    if (!this.filePath) return false
    try {
      return await RecorderIsRecording(this.filePath)
    } catch {
      return false
    }
  }
}

/**
 * 解析 cast v2 文件内容为可回放的事件序列。
 *
 * @returns { header, events } header 为 cast header 对象；events 为
 *   [elapsed, "o"|"i", data] 三元组数组，按 elapsed 升序。
 */
export interface ParsedCastHeader {
  version: number
  width: number
  height: number
  timestamp: number
  env?: Record<string, string>
}

export interface CastEvent {
  time: number
  type: 'o' | 'i' | string
  data: string
}

export interface ParsedCast {
  header: ParsedCastHeader | null
  events: CastEvent[]
  /** 最后一帧的 elapsed 时间（秒），用于进度条总长。 */
  duration: number
}

export function parseCastContent(content: string): ParsedCast {
  const lines = content.split('\n')
  let header: ParsedCastHeader | null = null
  const events: CastEvent[] = []
  let duration = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (i === 0 || (header === null && line.startsWith('{'))) {
      // header 行：JSON object
      try {
        header = JSON.parse(line) as ParsedCastHeader
      } catch {
        // 非 JSON header，跳过
      }
      continue
    }
    // 数据行：[elapsed, "o", "data"]
    try {
      const arr = JSON.parse(line) as [number, string, string]
      if (Array.isArray(arr) && arr.length >= 3 && typeof arr[0] === 'number') {
        events.push({ time: arr[0], type: arr[1], data: arr[2] })
        if (arr[0] > duration) duration = arr[0]
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return { header, events, duration }
}