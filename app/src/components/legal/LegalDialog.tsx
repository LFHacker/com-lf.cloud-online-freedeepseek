import { useState } from 'react'
import { LEGAL_DOCS, type LegalDoc } from '../../legal/documents.js'
import styles from './LegalDialog.module.css'

/**
 * 协议与声明全文查看。
 *
 * 为什么做成全屏弹层而不是新页面：这些内容通常在"注册前"或"设置里"顺手看一眼，
 * 跳走会打断当前的填写流程。
 */
export const LegalDialog = ({
  initial,
  onClose,
}: {
  initial?: LegalDoc['id']
  onClose: () => void
}) => {
  const [active, setActive] = useState<LegalDoc['id']>(initial ?? 'terms')
  const doc = LEGAL_DOCS.find((item) => item.id === active) ?? LEGAL_DOCS[0]

  return (
    <div className={styles.overlay} role="dialog" aria-modal>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.tabs}>
            {LEGAL_DOCS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === active ? styles.tabActive : styles.tab}
                onClick={() => setActive(item.id)}
              >
                {item.title}
              </button>
            ))}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className={styles.meta}>
          版本 {doc.version} · 更新于 {doc.updatedAt}
        </div>
        <div className={styles.body}>
          {doc.sections.map((section) => (
            <section key={section.heading} className={styles.section}>
              <h3 className={styles.heading}>{section.heading}</h3>
              {section.body.map((paragraph) => (
                <p key={paragraph} className={styles.paragraph}>
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.done} onClick={onClose}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  )
}
