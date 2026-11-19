import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportStage,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { startCloudSync, useCloudSync } from '../../services/sync/cloudSync.js'
import {
  getAppInfo,
  isUpdateSupported,
  openInstallPermission,
  runUpdate,
  type UpdateProgress,
} from '../../services/update/index.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  DEFAULT_API_ORIGIN,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  MODEL_OPTIONS,
  isChineseBrowser,
  setApiOrigin,
  setLocale,
  setContextInfo,
  setLocation,
  setModel,
  setSystemPrompt,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import { reportStep } from '../../services/diagnostics.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { AccountField } from './AccountField.js'
import { UpstreamKeyField } from './UpstreamKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'advanced', label: 'settingDialogAsideAdvancedOptionLabel', icon: <IconLinkOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失导入状态
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <ContextInfoSetting />
              <UpdateField />
            </>
          ) : section === 'advanced' ? (
            <AdvancedSettings />
          ) : (
            <>
              <AccountField />
              <UpstreamKeyField />
              <CloudSyncField disabled={historyBusy} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
          {/* 版本号放在弹窗内部底部：装没装上新版一眼就能确认 */}
          <div className={styles.versionLine}>{'v' + __APP_VERSION__}</div>
        </div>
      </Modal>
      {historyImport.busy ? <ImportOverlay historyImport={historyImport} /> : null}
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  /** IP 推断出来的位置（用户没手填时才生效） */
  const ipLocation = useSettings((state) => state.ipLocation)
  /**
   * ipLocation 里存的是行政区划**代码**（'330000'），显示前要换回名字，
   * 否则界面上会出现"330000 330100"这种看不懂的东西。
   */
  const ipProvince = provinces.find((item) => item.code === ipLocation?.province)
  const ipCity = ipProvince?.cities.find((item) => item.code === ipLocation?.city)
  const ipLabel = [ipProvince?.name, ipCity?.name].filter(Boolean).join(' ')
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      /*
        说明当前生效来源：
        · 手填过 → 以手填为准
        · 没填但 IP 推断出来了 → 显示"按 IP 推断：省/市"
        · 都没有 → 提示可以手动选
        这样用户不会疑惑"模型怎么知道我在哪"。
      */
      status={
        location
          ? null
          : ipLocation
            ? { key: 'settingsLocationFromIp', params: { place: ipLabel } }
            : { key: 'settingsLocationEmpty' }
      }
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 停手多久后自动提交：够短（不用等），够长（不打断连续输入） */
const COMMIT_DEBOUNCE_MS = 600

/**
 * 运行时配置的文本输入。
 *
 * 提交策略三条一起做，缺任何一条都会让用户难受：
 *  1. **停手 600ms 自动提交** —— 填完不用按回车（原来的设计逼着按回车，反直觉）
 *  2. **失焦 / 回车立即提交** —— 快速操作不等防抖
 *  3. **聚焦期间不让外部值覆盖草稿** —— 否则「删空 → 归一化回默认值 → 输入框跳走」，
 *     根本没法重新输入（这正是当初改成"回车才提交"的原因）
 */
const RuntimeTextField = ({
  label,
  hint,
  value,
  placeholder,
  inputMode,
  onCommit,
}: {
  label: string
  hint: string
  value: string
  placeholder: string
  inputMode?: 'url'
  onCommit: (value: string) => void
}) => {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const timer = useRef<number | null>(null)
  // 用 ref 存最新值：防抖回调与卸载清理里拿到的都是闭包里的旧值
  const draftRef = useRef(draft)
  const valueRef = useRef(value)
  draftRef.current = draft
  valueRef.current = value

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  // 只在未聚焦时同步外部值（例如点了「恢复默认」）
  useEffect(() => {
    if (!focused) {
      setDraft(value)
    }
  }, [value, focused])

  // 卸载时清掉待执行的防抖，避免对已卸载组件提交
  useEffect(() => clearTimer, [])

  const commit = () => {
    clearTimer()
    if (draftRef.current !== valueRef.current) {
      onCommit(draftRef.current)
    }
  }

  const schedule = () => {
    clearTimer()
    timer.current = window.setTimeout(commit, COMMIT_DEBOUNCE_MS)
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{label}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            inputMode={inputMode}
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            placeholder={placeholder}
            value={draft}
            onFocus={() => setFocused(true)}
            onChange={(event) => {
              setDraft(event.target.value)
              draftRef.current = event.target.value
              schedule()
            }}
            onBlur={() => {
              setFocused(false)
              commit()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                commit()
              }
            }}
          />
        </div>
        <div className={styles.description}>{hint}</div>
      </div>
    </div>
  )
}

/**
 * 高级：API 地址、模型、System Prompt。
 * 这三项原先写死在源码里（client.ts 的 __API_ORIGIN__、store.ts 的 MODEL / SYSTEM_PROMPT），
 * 改成运行时配置后，接自建网关、换模型、注入知识库都不需要重新构建。
 */
const AdvancedSettings = () => {
  const t = useTranslate()
  const apiOrigin = useSettings((state) => state.apiOrigin)
  const model = useSettings((state) => state.model)
  const systemPrompt = useSettings((state) => state.systemPrompt)
  const isDefault =
    apiOrigin === DEFAULT_API_ORIGIN &&
    model === DEFAULT_MODEL &&
    systemPrompt === DEFAULT_SYSTEM_PROMPT
  return (
    <>
      <RuntimeTextField
        label={t('settingsApiOrigin')}
        hint={t('settingsApiOriginHint', { origin: DEFAULT_API_ORIGIN })}
        value={apiOrigin}
        placeholder={DEFAULT_API_ORIGIN}
        inputMode="url"
        onCommit={setApiOrigin}
      />
      <SettingCell
        label={t('settingsModel')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingsModel')}
            value={model}
            options={MODEL_OPTIONS.map((item) => ({ value: item, label: item }))}
            onChange={setModel}
          />
        }
      />
      <RuntimeTextField
        label={t('settingsSystemPrompt')}
        hint={t('settingsSystemPromptHint')}
        value={systemPrompt}
        placeholder={DEFAULT_SYSTEM_PROMPT}
        onCommit={setSystemPrompt}
      />
      <SettingCell
        label={t('settingsRestoreDefault')}
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={isDefault}
            onClick={() => {
              setApiOrigin(DEFAULT_API_ORIGIN)
              setModel(DEFAULT_MODEL)
              setSystemPrompt(DEFAULT_SYSTEM_PROMPT)
            }}
          >
            {t('settingsRestoreDefault')}
          </Button>
        }
      />
    </>
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
        {/* 官方导出包常有几百 MB（大部分是图片），确认前先让人看到体积 */}
        {historyImport.file ? (
          <div className={styles.importConfirmText}>
            {t('historyImportFileSize', {
              name: historyImport.file.name,
              size: formatSize(historyImport.file.size),
            })}
          </div>
        ) : null}
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 环境信息总开关：是否把「当前时间（精确到分）+ 大致位置」告诉模型。
 *
 * 关掉后模型完全不知道现在几点、你在哪个地区 —— 问"今天几号""本地天气"
 * 这类问题会答不上来；但也不再有任何时间/位置信息离开设备。
 */
const ContextInfoSetting = () => {
  const t = useTranslate()
  const contextInfo = useSettings((state) => state.contextInfo)
  return (
    <SettingCell
      label={t('settingsContextInfo')}
      status={{
        key: contextInfo ? 'settingsContextInfoOn' : 'settingsContextInfoOff',
      }}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={contextInfo}
          aria-label={t('settingsContextInfo')}
          className={clsx(styles.switch, contextInfo && styles.switchOn)}
          onClick={() => setContextInfo(!contextInfo)}
        >
          <span className={styles.switchKnob} />
        </button>
      }
    />
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
/** 导入阶段 → 界面文案。卡住时能看出停在哪一步 */
const stageStatusKey: Record<ImportStage, TranslationKey> = {
  check: 'historyImportStageCheck',
  prepare: 'historyImportStagePrepare',
  copy: 'historyImportStageCopy',
  read: 'historyImportStageRead',
  commit: 'historyImportStageCommit',
}

const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)
  /** 取消请求：导入循环在条目之间检查它 */
  const cancelRef = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    reportStep('import:confirm', { name: file.name, size: file.size, type: file.type })
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      // 开跑前先确认空间够不够：手机 WebView 的存储配额比桌面小得多，
      // 190 MB 图片最容易在这里卡住（真实反馈就是"上传后按钮变灰、什么都没发生"）。
      // 桌面实测 224 MB 的包解压后占 268 MB，按 1.5 倍留余量。
      const needed = file.size * 1.5
      const estimate = await navigator.storage?.estimate?.()
      reportStep('import:storage-estimate', {
        quota: estimate?.quota ?? null,
        usage: estimate?.usage ?? null,
        needed,
      })
      if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        const free = (estimate.quota ?? 0) - (estimate.usage ?? 0)
        if (free < needed) {
          setStatus({
            key: 'historyImportNoSpace',
            params: { need: formatSize(needed), free: formatSize(free) },
            error: true,
          })
          return
        }
      }
      // 申请持久化存储，避免系统在空间紧张时回收已导入的图片
      void navigator.storage?.persist?.()

      // 大包（官方导出 224 MB / 1800+ 条目）没有进度就只能干等，用户会以为卡死。
      // 按条目数上报，节流到约每 120ms 刷一次，避免每条目都触发 React 更新。
      let lastPaint = 0
      // 卡死检测：任何阶段/进度变化都会刷新心跳；60 秒没有任何动静就明确提示，
      // 而不是让按钮一直灰着、界面一片空白（真实反馈就是这样，看不出卡在哪）。
      let lastTick = Date.now()
      const touch = () => {
        lastTick = Date.now()
      }
      const watchdog = window.setInterval(() => {
        if (Date.now() - lastTick > 60_000) {
          window.clearInterval(watchdog)
          setStatus({ key: 'historyImportStalled', error: true })
        }
      }, 3000)
      touch()
      const result = await importHistory(
        file,
        (done, total) => {
          touch()
          const now = Date.now()
          if (done !== total && now - lastPaint < 120) {
            return
          }
          lastPaint = now
          setStatus({ key: 'historyImporting', params: { done, total } })
        },
        (stage) => {
          touch()
          setStatus({ key: stageStatusKey[stage] })
        },
        () => cancelRef.current
      )
      window.clearInterval(watchdog)
      // 图片失败也要如实说明：来源临时文件被系统回收时，对话已导入但图片可能缺一部分
      if (result.imagesFailed > 0) {
        setStatus({
          key: 'historyImportedPartial',
          params: { count: result.count, failed: result.imagesFailed },
        })
      } else {
        setStatus({
          key:
            result.imagesStored > 0
              ? 'historyImportedWithImages'
              : result.count === 1
                ? 'historyImportedOne'
                : 'historyImported',
          params: { count: result.count, images: result.imagesStored },
        })
      }
    } catch (error) {
      // ⚠️ 原来只给一句通用的「导入失败」，把真实原因吞掉了 —— 用户只看到"没反应"，
      // 也无从判断是文件坏了、版本不对还是内容不完整。
      // errorStatus 会把 BackupError 的具体 key 带出来，界面显示成对应文案。
      reportStep('import:error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.slice(0, 800) : undefined,
      })
      // 用户主动取消不是"失败"，单独给一条文案，别用通用失败提示盖住
      if (error instanceof BackupError && error.key === 'backupCancelled') {
        setStatus({ key: 'historyImportCancelled' })
      } else {
        setStatus(errorStatus('historyImportFailed', error))
      }
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  /**
   * 取消导入。
   *
   * 两条路径都要能脱身：
   * 1. 正常取消：置标志，导入循环在下一个条目处中止，暂存被清掉。
   * 2. 卡死取消：如果 3 秒内没有真正结束（例如卡在读 ZIP 目录、循环根本没走到），
   *    强制解锁 UI —— 卡住的流程不可能走到 commit，所以强制解锁是安全的，
   *    否则按钮会一直灰着，用户只能杀进程。
   */
  const cancelImport = () => {
    cancelRef.current = true
    setStatus({ key: 'historyImportCancelling' })
    window.setTimeout(() => {
      if (!importing.current) {
        return
      }
      reportStep('import:cancel-forced')
      useChatStore.setState({ importingHistory: false })
      importing.current = false
      setBusy(false)
      setStatus({ key: 'historyImportCancelled' })
    }, 3000)
  }

  return {
    file,
    busy,
    status,
    cancelImport,
    select: setFile,
    cancel: () => setFile(null),
    confirm,
  }
}

/**
 * 导入遮罩：半透明背景 + 居中加载圈 + 状态文字 + 底部取消按钮。
 *
 * 为什么需要：导入一旦卡住，界面上只剩"按钮变灰"，用户既不知道在做什么、
 * 也没有任何办法脱身。遮罩至少告诉人"正在做什么"，取消按钮给了退路。
 */
const ImportOverlay = ({ historyImport }: { historyImport: ReturnType<typeof useHistoryImport> }) => {
  const t = useTranslate()
  const { status } = historyImport
  return createPortal(
    <div className={styles.importOverlay} role="alertdialog" aria-busy="true">
      <div className={styles.importOverlayCard}>
        <div className={styles.importSpinner} aria-hidden />
        <div className={styles.importOverlayStatus}>
          {status ? t(status.key, status.reason ? { message: t(status.reason) } : status.params) : t('historyImporting')}
        </div>
        <div className={styles.importOverlayActions}>
          <Button variant="outlined" size="m" onClick={historyImport.cancelImport}>
            {t('historyImportCancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
/**
 * 「同步到云端」：把本地会话与附件补推到云端，并把结果显示出来。
 *
 * 为什么必须有一个手动入口：
 *   导入 1000 条历史之后的那次自动推送是 fire-and-forget —— 它失败时界面上**什么都没有**，
 *   用户只能得出"云端就是没有"这个结论（真实事故）。而重试一次要重发上百 MB，
 *   所以必须：① 增量（已同步的跳过）② 看得见进度 ③ 能反复点。
 *
 * ⚠️ 运行状态**必须放在模块级 store**（`services/sync/cloudSync.ts`），不能放组件里：
 *   设置弹窗是 `open ? <Modal> : null`，一关就卸载、`useState` 全丢。
 *   之前就因为这个：关掉设置再回来显示"没在跑"，而旧锁还锁着 → 再点毫无反应。
 */
const CloudSyncField = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const running = useCloudSync((state) => state.running)
  const progress = useCloudSync((state) => state.progress)
  const result = useCloudSync((state) => state.result)
  const error = useCloudSync((state) => state.error)
  /**
   * 本机实际存了多少个附件原件。
   * 这一行是给"附件传不上去"准备的诊断：如果它是 0，说明导入的包里就没有图片，
   * 再点多少次同步也没用；如果它有几百个却一个都没传上去，那才是别的问题。
   */
  const [localFiles, setLocalFiles] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void import('../../services/chat/db.js')
      .then((db) => db.countStoredFiles())
      .then((count) => {
        if (alive) {
          setLocalFiles(count)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [running])


  /**
   * 状态完全由 store 推导：组件重新挂载后看到的是同一份进度，
   * 不需要（也不能）在组件里重新记一遍。
   */
  const status = ((): Status => {
    if (running) {
      if (!progress || progress.phase === 'sessions') {
        return progress && progress.total > 0
          ? { key: 'cloudSyncSessions', params: { done: progress.done, total: progress.total } }
          : { key: 'cloudSyncBusy' }
      }
      return { key: 'cloudSyncFiles', params: { done: progress.done, total: progress.total } }
    }
    if (error) {
      return { key: 'cloudSyncFailed', params: { message: error }, error: true }
    }
    if (!result) {
      return null
    }
    const failed = result.sessionsFailed + result.filesFailed
    const nothingHappened =
      result.sessionsPushed === 0 && result.filesUploaded === 0 && result.sessionsSkipped === 0
    /**
     * 三种结局要分开说，否则用户没法判断下一步该做什么：
     *  · 有失败项 → 网络/服务端问题，重试有意义
     *  · 没有失败、但有"本机缺原件" → 数据本身不完整（导入包没带图片），重试没用
     *  · 都正常 → 完成
     */
    const params = {
      sessions: result.sessionsPushed,
      files: result.filesUploaded,
      skipped: result.sessionsSkipped,
      failed,
      localFiles: result.localFiles,
    }
    if (nothingHappened && result.error) {
      return { key: 'cloudSyncFailed', params: { message: result.error }, error: true }
    }
    return failed > 0
      ? { key: 'cloudSyncPartial', params, error: true }
      : { key: 'cloudSyncDone', params }
  })()

  return (
    <SettingCell
      label={t('cloudSyncLabel')}
      description={
        localFiles === null
          ? t('cloudSyncDescription')
          : `${t('cloudSyncDescription')} ${t('cloudSyncLocalFiles', { count: localFiles })}`
      }
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || running}
          onClick={() => void startCloudSync()}
        >
          <IconRefreshOutline16 />
          {t(running ? 'cloudSyncBusy' : 'cloudSyncAction')}
        </Button>
      }
    />
  )
}

/**
 * 「检查更新」。
 *
 * 为什么只有一个按钮 + 一行状态：更新是"点了就该走完"的事，
 * 用户只需要知道：有没有新版、现在下到哪、下来之后要不要授权。
 *
 * 通道按版本号自动判断（带 -debug 走 dev），不提供通道选择 —— 让用户选只会选错。
 */
const formatUpdateSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 KB'
  }
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

const UpdateField = () => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [canInstall, setCanInstall] = useState(true)
  const supported = isUpdateSupported()

  useEffect(() => {
    if (!supported) {
      return
    }
    void getAppInfo()
      .then((info) => {
        if (info) {
          setVersion(info.versionName)
          setCanInstall(info.canInstall)
        }
      })
      .catch(() => undefined)
  }, [supported])

  const check = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setStatus({ key: 'updateChecking' })
    const channel = (version ?? '').includes('-debug') ? 'dev' : 'release'
    const onProgress = (progress: UpdateProgress) => {
      setStatus({
        key: progress.phase === 'patch' ? 'updatePatching' : 'updateDownloading',
        params: { received: formatUpdateSize(progress.received), total: formatUpdateSize(progress.total) },
      })
    }
    const outcome = await runUpdate(channel, onProgress)
    if (outcome.kind === 'launched') {
      setStatus({
        key: outcome.viaPatch ? 'updateLaunchedViaPatch' : 'updateLaunched',
        params: { version: outcome.version, saved: formatUpdateSize(outcome.savedBytes) },
      })
    } else if (outcome.kind === 'up-to-date') {
      setStatus({ key: 'updateLatest', params: { version: outcome.version } })
    } else if (outcome.kind === 'needs-permission') {
      setStatus({ key: 'updateNeedsPermission', error: true })
      setCanInstall(false)
    } else if (outcome.kind === 'unsupported') {
      setStatus({ key: 'updateUnsupported', error: true })
    } else {
      setStatus({ key: 'updateFailed', params: { message: outcome.message }, error: true })
    }
    setBusy(false)
  }

  return (
    <SettingCell
      label={t('updateLabel')}
      description={
        version
          ? `${t('updateCurrentVersion', { version })} · ${t('updateDescription')}`
          : t('updateDescription')
      }
      status={status}
      action={
        <>
          {canInstall ? null : (
            <Button
              variant="outlined"
              size="s"
              className={styles.cellButton}
              disabled={!supported}
              onClick={() => void openInstallPermission()}
            >
              {t('updateGrantInstall')}
            </Button>
          )}
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={busy || !supported}
            onClick={() => void check()}
          >
            <IconRefreshOutline16 />
            {t(busy ? 'updateChecking' : 'updateCheck')}
          </Button>
        </>
      }
    />
  )
}

const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
