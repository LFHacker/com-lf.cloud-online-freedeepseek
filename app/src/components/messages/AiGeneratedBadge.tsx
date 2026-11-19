import { useTranslate } from '../../i18n/index.js'
import styles from './AiGeneratedBadge.module.css'

/**
 * 显式标识：AI 生成内容标记。
 *
 * 为什么必须每条都标（而不是只在页面底部写一句）：
 *  · 用户可能截图、转发、复制**单条回答**，脱离应用界面后
 *    底部那句提醒就消失了，接收方无从判断这是 AI 生成的内容
 *  · 《人工智能生成合成内容标识办法》要求"在文本起始、末尾或中间适当位置
 *    添加文字提示"，逐条标注是最稳妥的实现
 *
 * 刻意做得克制：小字、低对比、不抢注意力 —— 合规不等于难看。
 */
export const AiGeneratedBadge = () => {
  const t = useTranslate()
  return (
    <span className={styles.badge} title={t('aiBadgeHint')}>
      <span className={styles.dot} aria-hidden />
      {t('aiBadge')}
    </span>
  )
}
