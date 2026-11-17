declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/**
 * 构建期注入的应用版本（构建时用 APP_VERSION 环境变量指定）。
 *
 * 为什么需要：界面原本没有任何版本标识，用户"装了新版但看起来没变化"时
 * 无法自查是没装上、还是装上了但改动确实不可见。有这个就能一眼确认。
 */
declare const __APP_VERSION__: string

/**
 * 构建期预置的网关令牌（仅开发版使用）。
 * 为空字符串时行为与正式版一致：首次打开要求用户自己填。
 */
declare const __DEV_API_KEY__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
