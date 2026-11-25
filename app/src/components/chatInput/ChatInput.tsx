import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  IconDataOutline16,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, setPendingMemoryScope, stopReply, useChatStore } from '../../services/chat/store.js'
import type { MemoryScope } from '../../services/chat/types.js'
import { useOutbox } from '../../services/sync/outbox.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput, type VoiceInputStatus } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

/**
 * WebView 是否支持 `field-sizing: content`（Chrome 123+，现代安卓 WebView 普遍支持）。
 *
 * 支持时 textarea 能自己按内容长高，于是那个隐藏的 mirror **完全不必渲染**：
 * 少一次整段文本的排版，也少一个文本节点更新 —— 这是输入掉帧的主要来源。
 * 不支持时（老 WebView）保持原方案，行为不变。
 */
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/**
 * 工具条（开关 / 语音 / 附件 / 发送）。
 *
 * 单独抽出来并 memo：它是输入框里最贵的一块（3 个 Tooltip + 语音按钮 + 附件按钮），
 * 而它依赖的东西**都不随打字变化**。原来它跟文本框写在同一个组件里，
 * 于是每敲一个字都要把这一整排重渲染一遍 —— 纯属白做。
 *
 * ⚠️ 传进来的回调必须都是稳定引用（useCallback），否则 memo 等于没加。
 */
const ChatToolbar = memo(function ChatToolbar({
  thinking,
  search,
  memoryScope,
  memoryLocked,
  importingHistory,
  streaming,
  canSend,
  voiceStatus,
  voiceAvailable,
  voiceSeconds,
  onThinking,
  onSearch,
  onMemory,
  onVoice,
  onOpenFile,
  onSend,
  onStop,
}: {
  thinking: boolean
  search: boolean
  memoryScope: MemoryScope
  memoryLocked: boolean
  importingHistory: boolean
  streaming: boolean
  canSend: boolean
  voiceStatus: VoiceInputStatus
  voiceAvailable: boolean
  voiceSeconds: number
  onThinking: () => void
  onSearch: () => void
  onMemory: () => void
  onVoice: () => void
  onOpenFile: () => void
  onSend: () => void
  onStop: () => void
}) {
  const t = useTranslate()
  const togglesRef = useRef<HTMLDivElement>(null)

  // 宽度不够时收起文字标签（只留图标），否则这一排会被挤成两行
  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  return (
    <div className={styles.functionRow}>
      {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
      <div ref={togglesRef} className={styles.toggles}>
        <Tooltip content={t('deactivatedThinkTooltip')}>
          <button
            type="button"
            className={clsx(styles.toggle, thinking && styles.selected)}
            aria-label={t('thinkingSwitch')}
            aria-pressed={thinking}
            onClick={onThinking}
          >
            <IconThinkOutline14 />
            <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
          </button>
        </Tooltip>
        <Tooltip content={t('deactivatedSearchTooltip')}>
          <button
            type="button"
            className={clsx(styles.toggle, search && styles.selected)}
            aria-label={t('search')}
            aria-pressed={search}
            onClick={onSearch}
          >
            <IconGlobeLanguageOutline14 />
            <span className={styles.toggleLabel}>{t('search')}</span>
          </button>
        </Tooltip>
        <Tooltip content={memoryLocked ? t('memoryLockedTooltip') : t('memoryScopeTooltip')}>
          <button
            type="button"
            className={clsx(styles.toggle, memoryScope === 'global' && styles.selected)}
            aria-label={t('memoryScope')}
            aria-pressed={memoryScope === 'global'}
            disabled={memoryLocked}
            onClick={onMemory}
          >
            {/* 必须给图标：移动端标签会被收起（.collapsedToggles 隐藏 toggleLabel），
                没有图标时这个按钮会变成一颗完全没有内容的空白胶囊，用户根本发现不了 */}
            <IconDataOutline16 />
            <span className={styles.toggleLabel}>
              {memoryScope === 'global' ? t('memoryGlobal') : t('memoryLocal')}
            </span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.right}>
        <VoiceButton
          status={voiceStatus}
          disabled={!voiceAvailable}
          seconds={voiceSeconds}
          onClick={onVoice}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPaperclipOutline16 />}
          tooltip={t('uploadFile')}
          disabled={importingHistory}
          onClick={onOpenFile}
        />
        {streaming ? (
          <button
            type="button"
            className={styles.sendButton}
            aria-label={t('chatInputStopButtonTooltip')}
            onClick={onStop}
          >
            <IconStopFill16 />
          </button>
        ) : (
          <button
            type="button"
            className={clsx(styles.sendButton, !canSend && styles.disabled)}
            aria-label={t('send')}
            aria-disabled={!canSend}
            onClick={onSend}
          >
            <IconSendOutline16 />
          </button>
        )}
      </div>
    </div>
  )
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  // 记忆模式：新会话可选（创建时定死），已有会话只读显示
  const pendingScope = useChatStore((state) => state.pendingMemoryScope)
  const lockedScope = useChatStore((state) =>
    sessionId === null
      ? null
      : (state.sessions.find((item) => item.id === sessionId)?.memoryScope ?? 'local')
  )
  const memoryScope = lockedScope ?? pendingScope
  const memoryLocked = lockedScope !== null
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  /**
   * 服务端确认前（阶段 2-2）这个会话里始终有一条"未确认"的消息，
   * 这时不能再发 —— 两条同时确认会让两个回复流抢同一个槽。
   */
  const pendingSend = useOutbox((state) =>
    sessionId === null
      ? false
      : Object.values(state.entries).some(
          (entry) => entry.sessionId === sessionId && entry.status !== 'failed'
        )
  )
  const canSend = !importingHistory && !streaming && !pendingSend && voice.status === 'idle' && draftReady

  const send = useCallback(() => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey()) {
      return
    }
    if (!sendMessage(sessionId)) {
      if (pendingSend) {
        showToast({ key: 'sendWhilePending' })
      }
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }, [sessionId, voice.status, pendingSend, isMobile])

  const openFile = useCallback(() => {
    if (!useChatStore.getState().importingHistory && ensureApiKey()) {
      fileInputRef.current?.click()
    }
  }, [])

  /**
   * 录音开关走 ref：这个回调要传给 memo 过的工具条，
   * 引用必须稳定，否则工具条每帧都会重渲染（等于没 memo）。
   */
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const toggleVoice = useCallback(() => {
    const current = voiceRef.current
    if (
      current.status !== 'idle' ||
      (!useChatStore.getState().importingHistory && ensureApiKey())
    ) {
      void current.toggle()
    }
  }, [])

  const stop = useCallback(() => {
    stopReadAloud()
    if (sessionId) {
      stopReply(sessionId)
    }
  }, [sessionId])

  const toggleThinking = useCallback(() => setThinking(!thinking), [thinking])
  const toggleSearch = useCallback(() => setSearch(!search), [search])
  const toggleMemory = useCallback(
    () => setPendingMemoryScope(memoryScope === 'global' ? 'local' : 'global'),
    [memoryScope]
  )

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        {/* 撑高度用的镜像：只在 WebView 不支持 field-sizing 时生效（见 CSS） */}
        {SUPPORTS_FIELD_SIZING ? null : (
          <div className={styles.mirror} aria-hidden>
            {`${text}\n`}
          </div>
        )}
      </div>
      <ChatToolbar
        thinking={thinking}
        search={search}
        memoryScope={memoryScope}
        memoryLocked={memoryLocked}
        importingHistory={importingHistory}
        streaming={streaming && sessionId !== null}
        canSend={canSend}
        voiceStatus={voice.status}
        voiceAvailable={voice.available}
        voiceSeconds={voice.seconds}
        onThinking={toggleThinking}
        onSearch={toggleSearch}
        onMemory={toggleMemory}
        onVoice={toggleVoice}
        onOpenFile={openFile}
        onSend={send}
        onStop={stop}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      {dragging ? <DragMask /> : null}
    </div>
  )
}
