import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { changePassword } from '../../services/auth/client.js'
import { replaceToken, signOut, useAuth } from '../../services/auth/store.js'
import { apiOrigin } from '../../services/api/client.js'
import { renameSelf } from '../../services/auth/client.js'
import { loadBalance, loadUsageTotals, type BalanceInfo, type UsageTotals } from '../../services/usage/index.js'
import { LegalDialog } from '../legal/LegalDialog.js'
import type { LegalDoc } from '../../legal/documents.js'
import { useSettings } from '../../services/settings.js'
import styles from './Settings.module.css'

/**
 * 「数据管理」里的账号栏：显示当前登录邮箱、退出登录、修改密码。
 *
 * 取代了原来那个「API Key 掩码 + 铅笔」的输入框 ——
 * 有账号体系之后再让人手填一串令牌，既危险（令牌等于密码）也没必要。
 */
export const AccountField = () => {
  const t = useTranslate()
  const user = useAuth((state) => state.user)
  const [changing, setChanging] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [balance, setBalance] = useState<BalanceInfo[] | null>(null)
  /** 全部会话合计（服务端账本，用于与官方后台对照） */
  const [totals, setTotals] = useState<UsageTotals | null>(null)
  const [legalOpen, setLegalOpen] = useState<LegalDoc['id'] | null>(null)

  // 余额只在打开设置时拉一次；失败就静默不显示，不要为它弹错误
  useEffect(() => {
    let alive = true
    void loadBalance().then((result) => {
      if (alive && result) {
        setBalance(result.infos)
      }
    })
    void loadUsageTotals('all').then((result) => {
      if (alive && result) {
        setTotals(result)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const origin = apiOrigin()

  const submit = async () => {
    if (newPassword.length < 8) {
      setNotice({ text: t('accountPasswordTooShort'), error: true })
      return
    }
    if (newPassword !== confirm) {
      setNotice({ text: t('accountPasswordMismatch'), error: true })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const token = useAuth.getState()
      void token
      const result = await changePassword(
        // 令牌就存在 settings 里，这里从 store 取当前值
        (await import('../../services/settings.js')).useSettings.getState().apiKey ?? '',
        oldPassword,
        newPassword
      )
      if (result.token) {
        replaceToken(result.token)
      }
      setNotice({ text: t('accountPasswordChanged'), error: false })
      setChanging(false)
      setOldPassword('')
      setNewPassword('')
      setConfirm('')
    } catch (error) {
      setNotice({
        text: error instanceof Error && error.message ? error.message : t('accountPasswordFailed'),
        error: true,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.account}>
        <div className={styles.accountRow}>
          <div>
            <div className={styles.label}>{t('accountSignedInAs')}</div>
            <div className={styles.accountEmail}>{user?.email ?? t('accountUnknown')}</div>
            <div className={styles.accountMeta}>
              {user?.role === 'admin' ? t('accountRoleAdmin') : t('accountRoleUser')} · {origin}
            </div>
            {totals ? (
              <div className={styles.accountMeta}>
                {t('accountUsageAll')}：{totals.requests} {t('statsRequests')} ·{' '}
                {t('statsTotalInput')} {(totals.promptHit + totals.promptMiss).toLocaleString()} token
                （{t('statsCacheOf')}{' '}
                {Math.round((totals.promptHit / Math.max(1, totals.promptHit + totals.promptMiss)) * 100)}%{' '}
                {t('statsCacheHit')}） · {t('statsTotalOutput')} {totals.output.toLocaleString()} token ·{' '}
                {t('statsTotalCost')} ¥{totals.costCny.toFixed(4)}
              </div>
            ) : null}
            <div className={styles.accountMeta}>
              <button type="button" className={styles.accountSecondary} onClick={() => setLegalOpen('terms')}>
                用户服务协议
              </button>
              {' · '}
              <button type="button" className={styles.accountSecondary} onClick={() => setLegalOpen('privacy')}>
                隐私政策
              </button>
              {' · '}
              <button type="button" className={styles.accountSecondary} onClick={() => setLegalOpen('ai')}>
                AI 内容声明
              </button>
            </div>
            {legalOpen ? <LegalDialog initial={legalOpen} onClose={() => setLegalOpen(null)} /> : null}
            {balance && balance.length > 0 ? (
              <div className={styles.accountMeta}>
                {t('accountBalance')}：
                {balance.map((item) => (
                  <b key={item.currency}>
                    {item.currency === 'CNY' ? '¥' : '$'}
                    {item.total}
                  </b>
                ))}
              </div>
            ) : null}
            <div className={styles.accountMeta}>
              {t('accountUsername')}：{user?.username ?? '—'} · {t('accountPublicId')}：{user?.publicId ?? '—'}
            </div>
          </div>
          <button
            type="button"
            className={styles.accountAction}
            onClick={() => void signOut()}
          >
            {t('accountSignOut')}
          </button>
        </div>

        {editingName ? (
          <div className={styles.accountForm}>
            <input
              className={styles.accountInput}
              type="text"
              maxLength={20}
              placeholder={t('loginUsernameHint')}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
            <div className={styles.accountFormActions}>
              <button
                type="button"
                className={styles.accountAction}
                disabled={nameBusy || !draftName.trim()}
                onClick={() => {
                  void (async () => {
                    setNameBusy(true)
                    setNotice(null)
                    try {
                      const token = useSettings.getState().apiKey ?? ''
                      const updated = await renameSelf(token, draftName.trim())
                      useAuth.setState({ user: updated })
                      setEditingName(false)
                      setNotice({ text: t('accountNameChanged'), error: false })
                    } catch (error) {
                      setNotice({
                        text: error instanceof Error && error.message ? error.message : t('accountNameFailed'),
                        error: true,
                      })
                    } finally {
                      setNameBusy(false)
                    }
                  })()
                }}
              >
                {nameBusy ? t('loginSubmitting') : t('confirm')}
              </button>
              <button type="button" className={styles.accountSecondary} onClick={() => setEditingName(false)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.accountSecondary}
            onClick={() => {
              setDraftName(user?.username ?? '')
              setEditingName(true)
            }}
          >
            {t('accountChangeName')}
          </button>
        )}

        {changing ? (
          <div className={styles.accountForm}>
            <input
              className={styles.accountInput}
              type="password"
              placeholder={t('accountOldPassword')}
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
            />
            <input
              className={styles.accountInput}
              type="password"
              placeholder={t('accountNewPassword')}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <input
              className={styles.accountInput}
              type="password"
              placeholder={t('accountConfirmPassword')}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <div className={styles.accountFormActions}>
              <button
                type="button"
                className={styles.accountAction}
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? t('loginSubmitting') : t('confirm')}
              </button>
              <button
                type="button"
                className={styles.accountSecondary}
                onClick={() => {
                  setChanging(false)
                  setNotice(null)
                }}
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.accountSecondary}
            onClick={() => setChanging(true)}
          >
            {t('accountChangePassword')}
          </button>
        )}

        {notice ? (
          <div className={notice.error ? styles.error : styles.accountNotice}>{notice.text}</div>
        ) : null}
      </div>
    </div>
  )
}
