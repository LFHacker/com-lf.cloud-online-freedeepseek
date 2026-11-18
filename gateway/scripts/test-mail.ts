/**
 * 邮件通道自测：真发一封邮件，验证 SMTP 配置可用。
 *
 *   node scripts/test-mail.ts <收件人>
 *
 * 用的是和生产同一套 sendMail，不是另写一条路径 ——
 * 自测能通但不能代表生产能通，是最常见的坑。
 */
import { applyEnvFile } from './env.ts'
import { readSmtpConfig, sendMail } from '../src/mail/smtp.ts'

applyEnvFile('/etc/ds-gateway.env')

const to = process.argv[2] ?? process.env.MAIL_TEST_TO
if (!to) {
  console.error('用法: node scripts/test-mail.ts <收件人邮箱>')
  process.exit(1)
}

const config = readSmtpConfig(process.env)
if (!config) {
  console.error('未配置 SMTP_HOST/SMTP_USER/SMTP_PASS，无法发信')
  process.exit(1)
}

console.log(`  发往 ${to}（经 ${config.host}:${config.port}，账号 ${config.user}）`)
const started = Date.now()
await sendMail(config, {
  to,
  subject: '自由的deepseek 邮件通道自测',
  text: `这是一封自测邮件。\n\n如果你收到它，说明网关的发信功能正常。\n时间：${new Date().toISOString()}`,
})
console.log(`  ✅ 已投递，耗时 ${Date.now() - started}ms`)
