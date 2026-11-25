import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const query = window.matchMedia('not all and (min-width: 768px)')

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

/**
 * 元素自身的 overflow 是否可滚动。
 *
 * **只缓存样式部分**：overflow 由 CSS 决定，不会因为内容变多而变；
 * 而 `scrollHeight > clientHeight` 是会变的（刚打开时空列表、后来有内容），
 * 那部分必须每次现算，否则缓存的 false 会让"整页禁止滚动"误伤内部滚动区。
 */
const overflowCache = new WeakMap<Element, { y: boolean; x: boolean }>()

const overflowOf = (element: Element): { y: boolean; x: boolean } => {
  const cached = overflowCache.get(element)
  if (cached) {
    return cached
  }
  const style = getComputedStyle(element)
  const value = { y: /auto|scroll/.test(style.overflowY), x: /auto|scroll/.test(style.overflowX) }
  overflowCache.set(element, value)
  return value
}

/**
 * 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。
 *
 * ⚠️ 这里在**每个 touchmove** 上执行，是滚动/按压手感的关键路径。
 * 原实现对每一层祖先都调 `getComputedStyle` —— 拖一下就是几十次强制样式重算。
 * 现在两级判定：
 *  1. 祖先带 `data-scrollable` → 立刻放行（对已知滚动容器是最快路径）
 *  2. 否则用**缓存过的** overflow 判定，只有元素真的声明了 auto/scroll 才去读尺寸
 * 绝大多数祖先两个方向都不是滚动容器，于是连尺寸都不用读。
 */
const preventPageScroll = (event: TouchEvent) => {
  if (event.touches.length !== 1) {
    return
  }
  for (
    let element = event.target instanceof Element ? event.target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (element.hasAttribute('data-scrollable')) {
      return
    }
    const overflow = overflowOf(element)
    if (overflow.y && element.scrollHeight > element.clientHeight) {
      return
    }
    if (overflow.x && element.scrollWidth > element.clientWidth) {
      return
    }
  }
  event.preventDefault()
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', preventPageScroll, { passive: false })
    return () => document.removeEventListener('touchmove', preventPageScroll)
  }, [enabled])
}

/**
 * 键盘动画期间两次写入之间的最小间隔之外，还要在安静下来后补一次精确值：
 * resize 事件给出的经常是动画中间的高度，最终值往往要等动画结束才稳定。
 */
const SETTLE_MS = 180

/** 移动端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。 */
export const useMobileViewport = (enabled: boolean) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    const viewport = window.visualViewport
    const inputSelector = 'textarea, input:not([type="file"])'
    let animationFrame = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    /**
     * 上一次真正写进 CSS 的使用值。
     * 键盘动画期间 resize/scroll 会连续触发几十次，而**每次写变量都会让整棵树重排** ——
     * 值没变还写，就是纯粹的卡顿来源（这也是"输入框上下出现/隐藏发抖"的主因）。
     */
    let lastHeight = -1
    let lastTop = -1
    const reset = () => {
      clearTimeout(settleTimer)
      cancelAnimationFrame(animationFrame)
      lastHeight = -1
      lastTop = -1
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
    }
    const write = () => {
      const height = Math.round(viewport?.height ?? window.innerHeight)
      const top = Math.round(viewport?.offsetTop ?? 0)
      // 值没变就不写：1px 以内的抖动换不来任何视觉差异，只会换来一次全量布局
      if (height !== lastHeight) {
        lastHeight = height
        frame.style.setProperty('--app-viewport-height', `${height}px`)
      }
      if (top !== lastTop) {
        lastTop = top
        frame.style.setProperty('--app-viewport-top', `${top}px`)
      }
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && viewport.scale !== 1) {
        return
      }
      // 失焦后直接恢复 CSS 的全高布局，不等 Safari 收键盘后的 resize。
      if (!document.activeElement?.matches(inputSelector)) {
        reset()
        return
      }
      write()
      // 动画安静下来后再校准一次最终高度
      clearTimeout(settleTimer)
      settleTimer = setTimeout(write, SETTLE_MS)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准延迟更新的视口读数。
      update()
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (document.activeElement?.matches(inputSelector)) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      clearTimeout(settleTimer)
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [enabled])

  return frameRef
}
