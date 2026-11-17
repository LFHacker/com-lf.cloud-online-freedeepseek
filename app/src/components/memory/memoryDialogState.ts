import { create } from 'zustand'

/** 记忆管理弹窗的开合状态；侧边栏和设置里都可以打开 */
export const useMemoryDialog = create(() => ({ open: false }))

export const openMemoryDialog = () => useMemoryDialog.setState({ open: true })
export const closeMemoryDialog = () => useMemoryDialog.setState({ open: false })
