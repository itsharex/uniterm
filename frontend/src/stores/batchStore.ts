// F2: 批量多主机执行 — 状态管理
//
// 维护每台主机的执行状态（pending/running/success/failed）、输出缓冲、
// 耗时以及全局配置（并发数/超时/失败策略）。batchExecute.ts 在执行过程
// 中调用 actions 更新状态，BatchExecuteDialog.vue 通过 computed 响应式
// 渲染结果表格。
//
// 设计要点：
// - sessions 用 ref<BatchSession[]> 而非 Map，便于 el-table 直接绑定。
// - appendOutput 追加到对应 session 的 output 字段；输出可能很大，由
//   dialog 端做截断展示，store 不做截断（导出时需要完整输出）。
// - cancelRequested 是一个 ref 标志，batchExecute 在每轮并发获取下一个
//   任务前检查该标志，实现"停止"失败策略 + 用户主动取消。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type BatchSessionStatus = 'pending' | 'running' | 'success' | 'failed'

export interface BatchSession {
  /** ConnectionConfig.id，唯一标识一台主机 */
  hostId: string
  /** 显示名（ConnectionConfig.name） */
  hostName: string
  /** host:port 副标题，用于结果区区分同名主机 */
  hostSubtitle: string
  status: BatchSessionStatus
  /** 累积的远程输出（ANSI 原样保留，导出时剥离） */
  output: string
  /** 失败时的错误信息（异常/超时） */
  error?: string
  startTime?: number
  endTime?: number
}

export interface BatchConfig {
  /** 最大并发数，≥1 */
  concurrency: number
  /** 每台主机超时秒数，≤0 表示不超时 */
  timeout: number
  /** 失败策略：continue 继续执行其他主机；stop 取消所有未开始的主机 */
  onFailure: 'continue' | 'stop'
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  concurrency: 5,
  timeout: 30,
  onFailure: 'continue',
}

export const useBatchStore = defineStore('batch', () => {
  const sessions = ref<BatchSession[]>([])
  const isExecuting = ref(false)
  const config = ref<BatchConfig>({ ...DEFAULT_BATCH_CONFIG })
  /** 用户主动取消或 onFailure=stop 触发的取消标志 */
  const cancelRequested = ref(false)

  /** 初始化一批待执行的 session（清空旧结果） */
  function startBatch(hosts: { hostId: string; hostName: string; hostSubtitle: string }[], cfg: BatchConfig) {
    sessions.value = hosts.map(h => ({
      hostId: h.hostId,
      hostName: h.hostName,
      hostSubtitle: h.hostSubtitle,
      status: 'pending' as BatchSessionStatus,
      output: '',
    }))
    config.value = { ...cfg }
    isExecuting.value = true
    cancelRequested.value = false
  }

  /** 更新指定主机的状态 */
  function updateSessionStatus(hostId: string, status: BatchSessionStatus, error?: string) {
    const s = sessions.value.find(s => s.hostId === hostId)
    if (!s) return
    s.status = status
    if (status === 'running' && !s.startTime) {
      s.startTime = Date.now()
    }
    if (status === 'success' || status === 'failed') {
      s.endTime = Date.now()
    }
    if (error !== undefined) {
      s.error = error
    }
  }

  /** 追加输出到指定主机 */
  function appendOutput(hostId: string, chunk: string) {
    const s = sessions.value.find(s => s.hostId === hostId)
    if (s) {
      s.output += chunk
    }
  }

  /** 请求取消（用户点击取消按钮或 onFailure=stop 触发） */
  function requestCancel() {
    cancelRequested.value = true
  }

  /** 标记批量执行结束 */
  function finishBatch() {
    isExecuting.value = false
    // 将仍处于 pending/running 的 session 标记为 failed（被取消）
    for (const s of sessions.value) {
      if (s.status === 'pending' || s.status === 'running') {
        s.status = 'failed'
        s.error = s.error || 'Cancelled'
        s.endTime = Date.now()
      }
    }
  }

  /** 清空结果（保留配置） */
  function clearResults() {
    sessions.value = []
    isExecuting.value = false
    cancelRequested.value = false
  }

  /** 重置配置为默认值 */
  function resetConfig() {
    config.value = { ...DEFAULT_BATCH_CONFIG }
  }

  // ── 派生统计 ──
  function countByStatus(status: BatchSessionStatus): number {
    return sessions.value.filter(s => s.status === status).length
  }

  /** 已完成数（success + failed），用于进度显示 */
  function completedCount(): number {
    return countByStatus('success') + countByStatus('failed')
  }

  return {
    sessions,
    isExecuting,
    config,
    cancelRequested,
    startBatch,
    updateSessionStatus,
    appendOutput,
    requestCancel,
    finishBatch,
    clearResults,
    resetConfig,
    countByStatus,
    completedCount,
  }
})