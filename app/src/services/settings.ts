import { create } from 'zustand'
import type { ChatModel } from './api/types.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 连接与模型配置的构建期默认值。
 * 这三项以前是写死的常量（client.ts / store.ts），改成可运行时覆盖后，
 * 接自建网关、换模型、定制人格都不再需要重新构建。
 */
export const DEFAULT_API_ORIGIN: string = __API_ORIGIN__
export const DEFAULT_MODEL: ChatModel = 'deepseek-flash'
export const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 可选模型；与 api/types.ts 的 ChatModel 保持一致 */
export const MODEL_OPTIONS: readonly ChatModel[] = ['deepseek-flash', 'deepseek-v4-pro']

/**
 * 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、
 * 侧边栏收起状态，以及运行时连接配置（API 地址、模型、system prompt）。
 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  /**
   * 按 IP 推断的位置（缓存），用户手填的 location 优先于它。
   * 由 services/geo.ts 填充，不直接暴露给设置界面。
   */
  ipLocation: UserLocation | null
  /**
   * 总开关：是否把「当前时间 + 大致位置」告诉模型。
   * 关掉后 latest_reminder 整个不下发，模型就不知道现在几点、你在哪儿。
   */
  contextInfo: boolean
  siderCollapsed: boolean
  apiOrigin: string
  model: ChatModel
  systemPrompt: string
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  contextInfo: 'chat-demo:context-info',
  siderCollapsed: 'chat-demo:sider-collapsed',
  apiOrigin: 'chat-demo:api-origin',
  model: 'chat-demo:model',
  systemPrompt: 'chat-demo:system-prompt',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过或存了空值时回落构建期地址；末尾斜杠统一去掉，避免拼出 //v1 */
const normalizeOrigin = (value: string | null): string => {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_API_ORIGIN
}

const initialApiOrigin = (): string => normalizeOrigin(read(KEYS.apiOrigin))

/** 只接受白名单内的模型名，避免存进未知值后请求被服务端拒绝 */
const initialModel = (): ChatModel => {
  const saved = read(KEYS.model)
  return MODEL_OPTIONS.find((item) => item === saved) ?? DEFAULT_MODEL
}

/** 未保存过或存了空白时回落默认人格 */
const normalizeSystemPrompt = (value: string | null): string =>
  (value ?? '').trim() ? (value as string) : DEFAULT_SYSTEM_PROMPT

const initialSystemPrompt = (): string => normalizeSystemPrompt(read(KEYS.systemPrompt))

export const useSettings = create<Settings>(() => ({
  // 开发版可在构建时预置令牌；用户手动改过之后以本地值为准
  apiKey: read(KEYS.apiKey) ?? (__DEV_API_KEY__ || null),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  // 默认开启：只有显式关过（存了 'false'）才关闭
  contextInfo: read(KEYS.contextInfo) !== 'false',
  ipLocation: null,
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  apiOrigin: initialApiOrigin(),
  model: initialModel(),
  systemPrompt: initialSystemPrompt(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setContextInfo = (contextInfo: boolean) => {
  write(KEYS.contextInfo, String(contextInfo))
  useSettings.setState({ contextInfo })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

/** 与构建期默认值一致时不写存储，保持"未覆盖"的语义 */
export const setApiOrigin = (value: string) => {
  const apiOrigin = normalizeOrigin(value)
  write(KEYS.apiOrigin, apiOrigin === DEFAULT_API_ORIGIN ? null : apiOrigin)
  useSettings.setState({ apiOrigin })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model === DEFAULT_MODEL ? null : model)
  useSettings.setState({ model })
}

export const setSystemPrompt = (value: string) => {
  const systemPrompt = normalizeSystemPrompt(value)
  write(
    KEYS.systemPrompt,
    systemPrompt === DEFAULT_SYSTEM_PROMPT ? null : systemPrompt
  )
  useSettings.setState({ systemPrompt })
}
