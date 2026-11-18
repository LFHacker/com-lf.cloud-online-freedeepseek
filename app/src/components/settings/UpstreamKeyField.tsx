import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { bindUpstreamKey, getUpstreamKey, unbindUpstreamKey } from '../../services/auth/client.js'
import { useAuth } from '../../services/auth/store.js'
import {
  cachedUpstreamKey,
  clearUpstreamKey,
  loadUpstreamKey,
  saveUpstreamKey,
} from '../../services/secure/upstreamKey.js'
import { useSettings } from '../../services/settings.js'
import styles from './Settings.module.css'

/**
 * DeepSeek 官方 Key 的配置栏。
 *
 * 数据流向（用户要求）：
 *   输入 → 先让服务端调一次 /models 验证 → 通过后
 *     ① 本机加密保存原文（AES-GCM，主密钥也在本机）
 *     ② 服务端只留 sha256 前 16 位指纹，用于回答「这个账号配过 Key 没有」
 * 之后每个聊天请求把它放进 x-deepseek-key 头，网关转发完即丢弃。
 */
export const UpstreamKeyField = () => {
  const t = useTranslate()
  const token = useSettings((state) => state.apiKey)
  const signedIn = useAuth((state) => state.status === 'signedIn')
  const [masked, setMasked] = useState<string | null>(null)
  const [hasLocal, setHasLocal] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    if (!signedIn || !token) {
      return
    }
    let alive = true
    void (async () => {
      await loadUpstreamKey().catch(() => null)
      if (!alive) {
        return
      }
      setHasLocal(Boolean(cachedUpstreamKey()))
      try {
        const result = await getUpstreamKey(token)
        if (alive && result.upstreamKey.bound) {
          setMasked(result.upstreamKey.masked ?? null)
        }
      } catch {
        // 网络失败不打扰用户：本地有没有 Key 我们自己知道
      }
    })()
    return () => {
      alive = false
    }
  }, [signedIn, token])

  const submit = async () => {
    const key = value.trim()
    if (!token) {
      return
    }
    if (key.length < 20 || !key.startsWith('sk-')) {
      setNotice({ text: t('upstreamKeyInvalid'), error: true })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const result = await bindUpstreamKey(token, key)
      await saveUpstreamKey(key)
      setMasked(result.upstreamKey.masked ?? null)
      setHasLocal(true)
      setEditing(false)
      setValue('')
      setNotice({
        text: result.sharedAccounts > 1 ? t('upstreamKeyShared') : t('upstreamKeySaved'),
        error: result.sharedAccounts > 1,
      })
    } catch (error) {
      setNotice({
        text: error instanceof Error && error.message ? error.message : t('upstreamKeyFailed'),
        error: true,
      })
    } finally {
      setBusy(false)
    }
  }

  const removeKey = async () => {
    if (!token) {
      return
    }
    setBusy(true)
    try {
      await unbindUpstreamKey(token).catch(() => undefined)
      await clearUpstreamKey()
      setMasked(null)
      setHasLocal(false)
      setNotice({ text: t('upstreamKeyRemoved'), error: false })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 两种状态要分开：
   *  · hasLocal  —— 本机有 Key，能发请求（这才是「可用」）
   *  · masked    —— 服务端有指纹，但本机可能没有（换设备/清过站点数据）
   * 混成一个布尔会出现「界面说已配置，一聊天却报缺少 Key」的诡异体验。
   */
  const usable = hasLocal
  const configured = usable || Boolean(masked)

  return (
    <div className={styles.cell}>
      <div className={styles.account}>
        <div className={styles.accountRow}>
          <div>
            <div className={styles.label}>{t('upstreamKeyTitle')}</div>
            <div className={styles.accountEmail}>
              {usable ? (masked ?? t('upstreamKeyConfigured')) : t('upstreamKeyMissing')}
            </div>
            <div className={styles.accountMeta}>
              {usable
                ? t('upstreamKeyHint')
                : masked
                  ? t('upstreamKeyLocalMissing', { masked })
                  : t('upstreamKeyHint')}
            </div>
          </div>
          {usable && !editing ? (
            <button type="button" className={styles.accountAction} onClick={() => setEditing(true)}>
              {t('upstreamKeyReplace')}
            </button>
          ) : null}
        </div>

        {!usable || editing ? (
          <div className={styles.accountForm}>
            <input
              className={styles.accountInput}
              type="password"
              placeholder={t('upstreamKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className={styles.accountFormActions}>
              <button
                type="button"
                className={styles.accountAction}
                disabled={busy || !value.trim()}
                onClick={() => void submit()}
              >
                {busy ? t('loginSubmitting') : t('upstreamKeyValidate')}
              </button>
              {editing ? (
                <button
                  type="button"
                  className={styles.accountSecondary}
                  onClick={() => {
                    setEditing(false)
                    setValue('')
                    setNotice(null)
                  }}
                >
                  {t('cancel')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {configured && !editing ? (
          <button type="button" className={styles.accountSecondary} disabled={busy} onClick={() => void removeKey()}>
            {t('upstreamKeyDelete')}
          </button>
        ) : null}

        {notice ? (
          <div className={notice.error ? styles.error : styles.accountNotice}>{notice.text}</div>
        ) : null}
      </div>
    </div>
  )
}
