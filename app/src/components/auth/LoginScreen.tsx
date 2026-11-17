import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { clearAuthError, signIn, signUp, useAuth } from '../../services/auth/store.js'
import styles from './LoginScreen.module.css'

type Mode = 'signIn' | 'signUp'

/**
 * 登录 / 注册。
 *
 * 为什么是全屏而不是弹窗：没登录时 App 里没有任何可用的东西
 * （聊天需要令牌、记忆需要令牌），弹窗式登录会让人以为「还能关掉试试」。
 */
export const LoginScreen = () => {
  const t = useTranslate()
  const busy = useAuth((state) => state.busy)
  const error = useAuth((state) => state.error)
  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = async () => {
    if (!email.trim() || !password) {
      return
    }
    if (mode === 'signIn') {
      await signIn(email, password)
    } else {
      await signUp(email, password)
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    clearAuthError()
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy

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

          <label className={styles.field}>
            <span className={styles.label}>{t('loginPassword')}</span>
            <input
              className={styles.input}
              type="password"
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === 'signUp' ? <span className={styles.hint}>{t('loginPasswordHint')}</span> : null}
          </label>

          {error ? <div className={styles.error}>{error}</div> : null}

          <button type="submit" className={styles.submit} disabled={!canSubmit}>
            {busy
              ? t('loginSubmitting')
              : mode === 'signIn'
                ? t('loginSignIn')
                : t('loginSignUp')}
          </button>
        </form>

        <div className={styles.footer}>{t('loginFooter')}</div>
      </div>
    </div>
  )
}
