import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import styles from './ImageLightbox.module.css'

/**
 * 图片放大查看。
 *
 * 为什么要自己做，而不是 window.open：
 * 在 Capacitor 的 WebView 里 window.open 会开一个新窗口，
 * 那个窗口**没有任何关闭入口** —— 用户放大后只能杀进程返回，
 * 实测就是这个 bug（"图片放大后无法缩小关闭返回"）。
 *
 * 所以改成应用内全屏层，并交出三条退路：
 *  1. 右上角 ✕
 *  2. 点空白处
 *  3. 系统返回键（通过 history 压栈 + popstate 捕获）
 *
 * 缩放：双指捏合 / 双击切换 1x-2.5x / 放大后可拖动。
 */
type PreviewState = {
  src: string | null
  alt: string
  open: (src: string, alt?: string) => void
  close: () => void
}

export const useImagePreview = create<PreviewState>((set) => ({
  src: null,
  alt: '',
  open: (src, alt = '') => set({ src, alt }),
  close: () => set({ src: null, alt: '' }),
}))

const MIN_SCALE = 1
const MAX_SCALE = 4
const DOUBLE_TAP_SCALE = 2.5

export const ImageLightbox = () => {
  const src = useImagePreview((state) => state.src)
  const alt = useImagePreview((state) => state.alt)
  const close = useImagePreview((state) => state.close)

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const lastTap = useRef(0)

  /** 每次打开新图都重置缩放，避免"上一张的缩放带到下一张" */
  useEffect(() => {
    if (src) {
      setScale(1)
      setOffset({ x: 0, y: 0 })
    }
  }, [src])

  /**
   * 系统返回键：压一个历史记录，返回时 popstate 关掉弹层。
   * 这样 Android 的返回键不会直接退出 App，而是先关图片。
   */
  useEffect(() => {
    if (!src) {
      return
    }
    window.history.pushState({ imageLightbox: true }, '')
    const onPop = () => close()
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 如果是通过 ✕ / 点空白关闭的，要把压入的那条历史退掉
      if (window.history.state?.imageLightbox) {
        window.history.back()
      }
    }
  }, [src, close])

  /** Esc 关闭（外接键盘/桌面端） */
  useEffect(() => {
    if (!src) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, close])

  const distanceOf = (touches: React.TouchList): number => {
    const [a, b] = [touches[0], touches[1]]
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 2) {
      pinch.current = { distance: distanceOf(event.touches), scale }
    } else if (event.touches.length === 1) {
      // 双击检测：300ms 内第二次单指按下
      const now = Date.now()
      if (now - lastTap.current < 300) {
        setScale((current) => (current > 1 ? 1 : DOUBLE_TAP_SCALE))
        setOffset({ x: 0, y: 0 })
        lastTap.current = 0
        return
      }
      lastTap.current = now
      if (scale > 1) {
        drag.current = {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY,
          offsetX: offset.x,
          offsetY: offset.y,
        }
      }
    }
  }, [scale, offset])

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 2 && pinch.current) {
      const next = (distanceOf(event.touches) / pinch.current.distance) * pinch.current.scale
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)))
      return
    }
    if (event.touches.length === 1 && drag.current) {
      setOffset({
        x: drag.current.offsetX + (event.touches[0].clientX - drag.current.x),
        y: drag.current.offsetY + (event.touches[0].clientY - drag.current.y),
      })
    }
  }, [])

  const onTouchEnd = useCallback(() => {
    pinch.current = null
    drag.current = null
    // 缩回 1x 时把位移也归零，否则图片会停在偏移位置
    setScale((current) => {
      if (current <= 1) {
        setOffset({ x: 0, y: 0 })
        return 1
      }
      return current
    })
  }, [])

  if (!src) {
    return null
  }

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal
      aria-label={alt || '图片预览'}
      onClick={close}
    >
      <button type="button" className={styles.close} aria-label="关闭" onClick={close}>
        ✕
      </button>
      <img
        className={styles.image}
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      />
      <div className={styles.hint}>双指缩放 · 双击放大 · 点空白或返回键关闭</div>
    </div>
  )
}
