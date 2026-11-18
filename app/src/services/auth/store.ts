/**
 * 登录状态。
 *
 * 只做一件事：把「令牌」和「当前用户」绑定在一起，并把令牌写回既有的
 * `services/settings`（apiKey 那个字段）。这样聊天、上传、记忆等所有
 * 已有代码完全不用改——它们本来就只认 apiKey。
 */
import { create } from 'zustand'
import { ApiError } from '../api/client.js'
import { setApiKey, useSettings } from '../settings.js'
import { loadUpstreamKey } from '../secure/upstreamKey.js'
import * as api from './client.js'
import { pullSessions } from '../sync/index.js'

export type AuthStatus = 'unknown' | 'signedOut' | 'signedIn'

type AuthState = {
  status: AuthStatus
  user: api.AuthUser | null
  /** 登录/注册请求进行中 */
  busy: boolean
  /** 直接展示给用户的错误文案 */
  error: string | null
}

export const useAuth = create<AuthState>(() => ({
  status: 'unknown',
  user: null,
  busy: false,
  error: null,
}))

const currentToken = (): string | null => useSettings.getState().apiKey

const message = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : '请求失败，请检查网络'

/**
 * 启动时校验已保存的令牌。
 *
 * 关键取舍：**网络错误不登出**。
 * 手机上没网、或网关临时重启都会让 /auth/me 失败，
 * 这时把用户踢回登录页会让人以为「数据没了」。
 * 只有服务端明确说 401 才清令牌。
 */
export const initAuth = async (): Promise<void> => {
  // 先把本地加密保存的官方 Key 解进内存，请求头要用
  await loadUpstreamKey().catch(() => null)
  const token = currentToken()
  if (!token) {
    useAuth.setState({ status: 'signedOut', user: null })
    return
  }
  try {
    const result = await api.me(token)
    useAuth.setState({ status: 'signedIn', user: result.user, error: null })
    /**
     * 登录成功 → 全量拉云端会话（换新手机就靠这一步恢复）。
     * 失败不影响使用：本地有什么用什么。
     */
    void pullSessions()
      .catch(() => undefined)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setApiKey(null)
      useAuth.setState({ status: 'signedOut', user: null })
      return
    }
    // 离线或网关不可达：保留登录态，聊天时自然会报网络错误
    useAuth.setState({ status: 'signedIn' })
  }
}

const applySession = (session: api.AuthSession) => {
  setApiKey(session.token)
  useAuth.setState({ status: 'signedIn', user: session.user, busy: false, error: null })
}

export const signIn = async (email: string, password: string): Promise<boolean> => {
  useAuth.setState({ busy: true, error: null })
  try {
    applySession(await api.login(email.trim(), password))
    return true
  } catch (error) {
    useAuth.setState({ busy: false, error: message(error) })
    return false
  }
}

export const signUp = async (email: string, password: string, code: string, username?: string): Promise<boolean> => {
  useAuth.setState({ busy: true, error: null })
  try {
    applySession(await api.register(email.trim(), password, code.trim(), username?.trim()))
    return true
  } catch (error) {
    useAuth.setState({ busy: false, error: message(error) })
    return false
  }
}

export const signOut = async (): Promise<void> => {
  const token = currentToken()
  if (token) {
    // 服务端吊销失败也要本地登出：否则用户会卡在「点了退出但还在里面」
    await api.logout(token).catch(() => undefined)
  }
  setApiKey(null)
  useAuth.setState({ status: 'signedOut', user: null, busy: false, error: null })
}

/** 设置页里改密码后，用新令牌替换旧的（网关改了密码会踢掉所有会话） */
export const replaceToken = (token: string): void => {
  setApiKey(token)
}

export const clearAuthError = (): void => useAuth.setState({ error: null })

/** 忘记密码：用邮箱验证码重置，成功后直接进入登录态 */
export const resetWithCode = async (email: string, code: string, newPassword: string): Promise<boolean> => {
  useAuth.setState({ busy: true, error: null })
  try {
    applySession(await api.resetPassword(email.trim(), code.trim(), newPassword))
    return true
  } catch (error) {
    useAuth.setState({ busy: false, error: message(error) })
    return false
  }
}

/** 发验证码；成功返回冷却秒数，失败抛错由界面显示 */
export const requestCode = async (email: string, purpose: 'register' | 'reset'): Promise<number> => {
  const result = await api.sendCode(email.trim(), purpose)
  return result.cooldownSeconds ?? 60
}

