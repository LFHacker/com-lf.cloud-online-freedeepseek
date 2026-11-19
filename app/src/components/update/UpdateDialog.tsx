import { useTranslate } from '../../i18n/index.js'
import { useUpdateStore } from '../../services/update/store.js'
import styles from './UpdateDialog.module.css'

/** 字节 → 人类可读（下载量用） */
const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 KB'
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 启动时的更新提示窗。
 *
 * 设计取向：
 *  · 把"更新内容"（服务端 notes）作为正文，用户能判断要不要更 —— 而不是只问"要不要更新"
 *  · 两个按钮并列：立即更新 / 稍后（稍后记住版本，本次启动不再打扰）
 *  · 更新中显示真实进度（下载 / 打补丁），失败原因就地展示，不另弹 alert
 */
export const UpdateDialog = () => {
  const t = useTranslate()
  const manifest = useUpdateStore((state) => state.manifest)
  const currentVersion = useUpdateStore((state) => state.currentVersion)
  const dialogOpen = useUpdateStore((state) => state.dialogOpen)
  const updating = useUpdateStore((state) => state.updating)
  const progress = useUpdateStore((state) => state.progress)
  const error = useUpdateStore((state) => state.error)
  const start = useUpdateStore((state) => state.start)
  const closeDialog = useUpdateStore((state) => state.closeDialog)

  if (!dialogOpen || !manifest) {
    return null
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0

  return (
    <div className={styles.overlay} role="dialog" aria-modal aria-labelledby="update-title">
      <div className={styles.panel}>
        <div className={styles.header}>
          <span id="update-title" className={styles.title}>
            {t('updateDialogTitle')}
          </span>
          <span className={styles.version}>
            {currentVersion ?? '?'} → {manifest.version}
          </span>
        </div>

        <div className={styles.meta}>
          {t('updateDialogSize', { size: formatSize(manifest.size) })}
          {manifest.notes ? '' : ` · ${t('updateDialogNoNotes')}`}
        </div>

        {/* 更新内容就是正文：用户据此决定要不要更 */}
        {manifest.notes ? (
          <div className={styles.notes}>
            <div className={styles.notesTitle}>{t('updateDialogNotes')}</div>
            <p className={styles.notesBody}>{manifest.notes}</p>
          </div>
        ) : null}

        {updating ? (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>
              {progress?.phase === 'patch'
                ? t('updatePhasePatch')
                : t('updatePhaseDownload')}
              {progress && progress.total > 0 ? ` ${percent}%` : ''}
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${percent}%` }} />
            </div>
            <div className={styles.progressHint}>
              {progress && progress.total > 0
                ? `${formatSize(progress.received)} / ${formatSize(progress.total)}`
                : t('updatePreparing')}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.later} onClick={closeDialog} disabled={updating}>
            {t('updateLater')}
          </button>
          <button type="button" className={styles.primary} onClick={() => void start()} disabled={updating}>
            {updating ? t('updateRunning') : error ? t('updateRetry') : t('updateNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
