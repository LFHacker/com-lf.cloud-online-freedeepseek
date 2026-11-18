/**
 * 账号接口的客户端。
 *
 * 所有请求都带 `x-api-key`（与聊天一致），这样网关侧只需要一套取令牌的逻辑。
 * 注意：这里**不缓存**任何东西，令牌的保存由 services/settings 负责，
 * 避免出现「两处各存一份、互相不知道对方清空了」的经典问题。
 */
import { ApiError, apiOrigin } from '../api/client.js'

export type AuthUser = {
  id: string
  email: string
  role: 'admin' | 'user'
  status: string
  createdAt: number
}

export type AuthSession = {
  token: string
  expiresAt: number
  user: AuthUser
}

export type MemorySummary = {
  sessions: number
  messages: number
  chunks: number
} | null

const errorMessages: Record<string, string> = {
  invalidEmail: '邮箱格式不正确',
  weakPassword: '密码至少 8 位',
  emailTaken: '该邮箱已注册，直接登录即可',
  badCredentials: '邮箱或密码不正确',
  disabled: '账号已被停用',
  signup_disabled: '本实例未开放注册，请联系管理员',
  unauthorized: '登录状态已失效，请重新登录',
  rate_limited: '请求过于频繁，请稍后再试',
}

/** 统一把服务端错误转成可显示的中文；未知错误保留原文便于排查 */
const toError = async (response: Response): Promise<never> => {
  let key = ''
  let message = ''
  try {
    const body = (await response.json()) as { error?: string; message?: string }
    key = body.error ?? ''
    message = body.message ?? ''
  } catch {
    // 非 JSON 响应（例如网关 502）走通用文案
  }
  const text = errorMessages[key] ?? message ?? `请求失败（HTTP ${response.status}）`
  // ApiError(kind, message, status)：调用方据 status === 401 判断登录失效
  throw new ApiError('http', text, response.status)
}

const post = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
  const response = await fetch(`${apiOrigin()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-api-key': token } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await toError(response)
  }
  return (await response.json()) as T
}

const get = async <T>(path: string, token: string): Promise<T> => {
  const response = await fetch(`${apiOrigin()}${path}`, { headers: { 'x-api-key': token } })
  if (!response.ok) {
    await toError(response)
  }
  return (await response.json()) as T
}

export const login = (email: string, password: string): Promise<AuthSession> =>
  post<AuthSession>('/auth/login', { email, password })

export const register = (email: string, password: string): Promise<AuthSession> =>
  post<AuthSession>('/auth/register', { email, password })

export const logout = (token: string): Promise<unknown> => post('/auth/logout', {}, token)

export const me = (
  token: string
): Promise<{ ok: boolean; user: AuthUser; memory: MemorySummary; legacyToken: boolean }> =>
  get('/auth/me', token)

export const changePassword = (
  token: string,
  oldPassword: string,
  newPassword: string
): Promise<{ token?: string }> => post('/auth/password', { oldPassword, newPassword }, token)

/** 官方 Key 绑定信息（服务端只回掩码与指纹） */
export type UpstreamKeyState = {
  bound: boolean
  masked?: string
  fingerprint?: string
  validatedAt?: number
}

const tokenOf = (token: string) => ({ 'x-api-key': token })

export const getUpstreamKey = async (token: string): Promise<{ upstreamKey: UpstreamKeyState }> => {
  const response = await fetch(`${apiOrigin()}/auth/upstream-key`, { headers: tokenOf(token) })
  if (!response.ok) {
    await toError(response)
  }
  return (await response.json()) as { upstreamKey: UpstreamKeyState }
}

export const bindUpstreamKey = async (
  token: string,
  key: string
): Promise<{ upstreamKey: UpstreamKeyState; sharedAccounts: number }> => {
  const response = await fetch(`${apiOrigin()}/auth/upstream-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...tokenOf(token) },
    body: JSON.stringify({ key }),
  })
  if (!response.ok) {
    await toError(response)
  }
  return (await response.json()) as { upstreamKey: UpstreamKeyState; sharedAccounts: number }
}

export const unbindUpstreamKey = async (token: string): Promise<void> => {
  const response = await fetch(`${apiOrigin()}/auth/upstream-key`, {
    method: 'DELETE',
    headers: tokenOf(token),
  })
  if (!response.ok) {
    await toError(response)
  }
}
