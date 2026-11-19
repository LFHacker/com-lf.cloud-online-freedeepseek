import { getRegionName, provinces, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

const locationName = (location: UserLocation | null, locale: Locale): string => {
  if (!location) {
    return ''
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

/** 补零 */
const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))

/**
 * 精确到分钟的本机时间，如 `2026-11-18 15:04`。
 *
 * 为什么精确到分钟而不是只给日期：
 *  · 「今天/昨天」「刚才说的那个」「半小时后提醒我」这类话，只给日期模型无从判断
 *  · 时区用浏览器本地时区，避免 UTC 跨日导致"星期几"和日期对不上
 */
export const formatDateTime = (date: Date): string =>
  `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`

/**
 * 模型约定的环境信息：时间 + 大致位置 + 平台 + 语言。
 *
 * 总开关 `contextInfo` 为假时不生成任何内容 —— 此时调用方不会下发该消息，
 * 模型完全不知道用户在何时何地说话。
 *
 * 位置只到省市一级，来自用户在设置里手填的 `location`（没有按 IP 自动推断）。
 */
export const createLatestReminder = (
  {
    locale,
    location,
    contextInfo,
  }: { locale: Locale; location: UserLocation | null; contextInfo?: boolean },
  now = new Date()
): string => {
  if (contextInfo === false) {
    return ''
  }
  return [
    formatDateTime(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale),
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
}
