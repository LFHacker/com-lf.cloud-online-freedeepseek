import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  clearAuthError,
  requestCode,
  resetWithCode,
  signIn,
  signUp,
  useAuth,
} from '../../services/auth/store.js'
import { LegalDialog } from '../legal/LegalDialog.js'
import { CONSENT_TEXT, type LegalDoc } from '../../legal/documents.js'
import styles from './LoginScreen.module.css'

type Mode = 'signIn' | 'signUp' | 'reset'

/**
 * 登录 / 注册 / 找回密码。
 *
 * 为什么是全屏而不是弹窗：没登录时 App 里没有任何可用的东西
 * （聊天要令牌、记忆要令牌），弹窗式登录会让人以为还能关掉试试。
 *
 * 注册与找回都要邮箱验证码：既是"这个邮箱是你的"的证明，
 * 也是防刷号的第一道门槛。
 */
export const LoginScreen = () => {
  const t = useTranslate()
  const busy = useAuth((state) => state.busy)
  const error = useAuth((state) => state.error)

  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  /**
   * 倒计时按**截止时间戳**算，而不是自己每秒减一。
   *
   * 原因：手机放进后台后 WebView 会节流/暂停定时器，减数法会停在那儿不动
   * （用户实测：切到后台再回来，倒计时卡住）。存截止时间的话，
   * 回到前台哪怕一个回调都没跑，重算一次差值就正确了。
   */
  const [deadline, setDeadline] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<string | null>(null)
  /** 注册必须勾选同意；登录不需要（老用户已同意过） */
  const [agreed, setAgreed] = useState(false)
  const [legalOpen, setLegalOpen] = useState<LegalDoc['id'] | null>(null)

  const cooldown = Math.max(0, Math.ceil((deadline - now) / 1000))

  useEffect(() => {
    if (deadline === 0) {
      return
    }
    const tick = () => setNow(Date.now())
    // 后台回来时立刻重算一次，不等下一个 interval
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tick()
      }
    }
    const id = setInterval(tick, 500)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', tick)
    }
  }, [deadline])

  const startCooldown = (seconds: number) => {
    setNow(Date.now())
    setDeadline(Date.now() + seconds * 1000)
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setCode('')
    setNotice(null)
    clearAuthError()
  }

  const sendCode = async () => {
    if (!email.trim() || cooldown > 0) {
      return
    }
    setNotice(null)
    clearAuthError()
    try {
      const seconds = await requestCode(email, mode === 'reset' ? 'reset' : 'register')
      startCooldown(seconds)
      setNotice(t('loginCodeSent'))
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : t('loginCodeFailed'))
    }
  }

  const submit = async () => {
    if (!email.trim()) {
      return
    }
    if (mode === 'signIn') {
      if (!password) {
        return
      }
      await signIn(email, password)
      return
    }
    if (!code.trim() || !password) {
      return
    }
    if (mode === 'signUp') {
      if (!agreed) {
        setNotice(null)
        return
      }
      await signUp(email, password, code, username.trim())
    } else {
      await resetWithCode(email, code, password)
    }
  }

  const needsCode = mode !== 'signIn'
  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!needsCode || code.trim().length > 0) &&
    (mode !== 'signUp' || agreed) &&
    !busy

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.bird} aria-hidden />
          <h1 className={styles.title}>{t('loginTitle')}</h1>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signIn'}
            className={mode === 'signIn' ? styles.tabActive : styles.tab}
            onClick={() => switchMode('signIn')}
          >
            {t('loginSignIn')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signUp'}
            className={mode === 'signUp' ? styles.tabActive : styles.tab}
            onClick={() => switchMode('signUp')}
          >
            {t('loginSignUp')}
          </button>
        </div>

        {mode === 'reset' ? (
          <div className={styles.resetHeader}>{t('loginResetTitle')}</div>
        ) : null}

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className={styles.field}>
            <span className={styles.label}>{t('loginEmail')}</span>
            <input
              className={styles.input}
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {mode === 'signUp' ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('loginUsername')}</span>
              <input
                className={styles.input}
                type="text"
                autoComplete="nickname"
                maxLength={20}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t('loginUsernameHint')}
              />
            </label>
          ) : null}

          {needsCode ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('loginCode')}</span>
              <div className={styles.codeRow}>
                <input
                  className={styles.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
                <button
                  type="button"
                  className={styles.codeButton}
                  disabled={cooldown > 0 || !email.trim()}
                  onClick={() => void sendCode()}
                >
                  {cooldown > 0 ? t('loginCodeWait', { seconds: cooldown }) : t('loginCodeSend')}
                </button>
              </div>
            </label>
          ) : null}

          <label className={styles.field}>
            <span className={styles.label}>
              {mode === 'reset' ? t('loginNewPassword') : t('loginPassword')}
            </span>
            <input
              className={styles.input}
              type="password"
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode !== 'signIn' ? <span className={styles.hint}>{t('loginPasswordHint')}</span> : null}
          </label>

          {mode === 'signUp' ? (
            <label className={styles.consent}>
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>
                {CONSENT_TEXT}
                <button type="button" className={styles.linkInline} onClick={() => setLegalOpen('terms')}>
                  《用户服务协议》
                </button>
                <button type="button" className={styles.linkInline} onClick={() => setLegalOpen('privacy')}>
                  《隐私政策》
                </button>
                <button type="button" className={styles.linkInline} onClick={() => setLegalOpen('ai')}>
                  《AI 生成内容声明》
                </button>
              </span>
            </label>
          ) : null}

          {notice ? <div className={styles.notice}>{notice}</div> : null}
          {error ? <div className={styles.error}>{error}</div> : null}

          <button type="submit" className={styles.submit} disabled={!canSubmit}>
            {busy
              ? t('loginSubmitting')
              : mode === 'signIn'
                ? t('loginSignIn')
                : mode === 'signUp'
                  ? t('loginSignUp')
                  : t('loginResetSubmit')}
          </button>

          {mode === 'signIn' ? (
            <button type="button" className={styles.linkButton} onClick={() => switchMode('reset')}>
              {t('loginForgot')}
            </button>
          ) : (
            <button type="button" className={styles.linkButton} onClick={() => switchMode('signIn')}>
              {t('loginBackToSignIn')}
            </button>
          )}
        </form>

        <div className={styles.footer}>{t('loginFooter')}</div>
      </div>
      {legalOpen ? <LegalDialog initial={legalOpen} onClose={() => setLegalOpen(null)} /> : null}
    </div>
  )
}
