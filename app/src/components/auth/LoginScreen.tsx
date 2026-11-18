import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  clearAuthError,
  requestCode,
  resetWithCode,
  signIn,
  signUp,
  useAuth,
} from '../../services/auth/store.js'
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
  const [cooldown, setCooldown] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) {
        clearInterval(timer.current)
      }
    },
    []
  )

  const startCooldown = (seconds: number) => {
    setCooldown(seconds)
    if (timer.current) {
      clearInterval(timer.current)
    }
    timer.current = setInterval(() => {
      setCooldown((value) => {
        if (value <= 1) {
          if (timer.current) {
            clearInterval(timer.current)
          }
          return 0
        }
        return value - 1
      })
    }, 1000)
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
      await signUp(email, password, code)
    } else {
      await resetWithCode(email, code, password)
    }
  }

  const needsCode = mode !== 'signIn'
  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (!needsCode || code.trim().length > 0) &&
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
    </div>
  )
}
