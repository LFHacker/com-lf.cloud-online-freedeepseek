/**
 * 客户端诊断上报。
 *
 * 背景：App 的「导入历史对话」在手机上会卡住且没有任何可见反馈
 * （按钮变灰、进度不出现）。桌面 Chrome 跑同一个 224 MB 包只要 18 秒，
 * 所以必须在真机现场留下痕迹，否则只能靠猜。
 *
 * 设计要点：
 * 1. **用 text/plain 发简单请求 + 令牌走查询参数** —— 避免 CORS 预检。
 *    卡死时如果预检失败，日志会连发都发不出去，而那正是最需要日志的时刻。
 * 2. **keepalive: true** —— 页面被切走或即将关闭时请求仍能发出。
 * 3. **绝不抛异常、绝不 await 阻塞业务** —— 诊断代码不能影响被诊断的流程。
 */
import { apiOrigin } from './api/client.js'
import { useSettings } from './settings.js'

/** 最近一次上报失败的原因，便于界面提示"日志没发出去" */
export let lastReportError: string | null = null

export const reportStep = (step: string, detail?: unknown): void => {
  try {
    const token = useSettings.getState().apiKey ?? ''
    const payload = JSON.stringify({
      step,
      t: Date.now(),
      detail: detail === undefined ? undefined : detail,
      ua: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 140),
    })
    /**
     * ⚠️ 令牌放在**请求体首行**，不能放查询串：
     * 查询串会被 Caddy 访问日志原样记录（实测泄漏过 97 条带令牌的记录）。
     * 请求体不进访问日志；同时保持 text/plain 简单请求，不触发 CORS 预检
     * （导入卡死时最需要日志，那一刻预检失败会连日志都发不出去）。
     */
    void fetch(`${apiOrigin()}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: `x-ds-token: ${token}\n${payload}`,
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) {
          lastReportError = `HTTP ${response.status}`
        }
      })
      .catch((error: unknown) => {
        lastReportError = error instanceof Error ? error.message : String(error)
      })
  } catch (error) {
    lastReportError = error instanceof Error ? error.message : String(error)
  }
}

/** 把未捕获的异常也送上去：导入卡死常常表现为某个 promise 静默 reject */
export const installDiagnosticsHooks = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportStep('unhandledrejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.slice(0, 800) : undefined,
    })
  })
  window.addEventListener('error', (event) => {
    reportStep('window.error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    })
  })
}
