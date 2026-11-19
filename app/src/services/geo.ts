/**
 * 按公网 IP 推断大致位置。
 *
 * 为什么由网关查而不是客户端自己查：
 *  · 客户端拿不到自己的公网 IP（只看到内网地址/运营商中转地址）
 *  · 用第三方在线 IP 库去查，等于把用户的 IP 交给那家公司
 *    → 网关用**离线库**（ip2region）在本地查，IP 不出服务器
 *
 * 精度只到省/市，够用且不越界：
 * 模型回答"今天天气""你是哪的人"这类问题时，知道省份就够，
 * 精确到街道既无必要，也不该被采集。
 */
import { apiOrigin } from './api/client.js'
import { useSettings } from './settings.js'
import { provinces, type UserLocation } from './location.js'

const ipLocationKey = 'chat-demo:ip-location'
/** 同一网络出口不太会天天变，缓存 24 小时足够，也避免每次启动都查 */
const TTL_MS = 24 * 3_600_000

type Cached = { at: number; location: UserLocation | null }

const readCache = (): Cached | null => {
  try {
    const raw = localStorage.getItem(ipLocationKey)
    return raw ? (JSON.parse(raw) as Cached) : null
  } catch {
    return null
  }
}

const writeCache = (location: UserLocation | null): void => {
  try {
    localStorage.setItem(ipLocationKey, JSON.stringify({ at: Date.now(), location }))
  } catch {
    // 存储不可用时忽略：下次启动再查
  }
}

/**
 * 取 IP 推断的位置（带 24 小时缓存）。
 *
 * 返回 null 表示推断不出（内网 IP、库无记录、网关不可达）——
 * 调用方应当退回"用户手填的位置"或干脆不提供位置。
 */
export const loadIpLocation = async (options: { force?: boolean } = {}): Promise<UserLocation | null> => {
  const cached = readCache()
  if (!options.force && cached && Date.now() - cached.at < TTL_MS) {
    return cached.location
  }
  try {
    const response = await fetch(`${apiOrigin()}/geo`, {
      headers: { 'x-api-key': useSettings.getState().apiKey ?? '' },
    })
    if (!response.ok) {
      return cached?.location ?? null
    }
    const payload = (await response.json()) as {
      found?: boolean
      country?: string
      region?: string
      city?: string
    }
    if (!payload.found || !payload.country) {
      writeCache(null)
      return null
    }
    const location: UserLocation = { region: payload.country }
    /**
     * 只有国内才细分到省/市：海外的行政区名称在 UI 里没有对应选项。
     *
     * ⚠️ 这里必须把**名字换成代码**：UserLocation.province/city 存的是
     * 行政区划代码（'330000' / '330100'），而 IP 库给的是名字（'浙江省' / '杭州市'）。
     * 直接存名字的话，渲染时按代码查不到，位置就只剩一个"中国" ——
     * 表现就是"模型说不知道你在哪"。
     */
    if (payload.country === 'CN') {
      const province = provinces.find(
        (item) => item.name === payload.region || item.name === `${payload.region}省`
      )
      if (province) {
        location.province = province.code
        // 城市名同样要换成代码；对不上就只给到省
        const city = province.cities.find(
          (item) => item.name === payload.city || item.name === `${payload.city}市`
        )
        location.city = city?.code
      }
    }
    writeCache(location)
    return location
  } catch {
    return cached?.location ?? null
  }
}
