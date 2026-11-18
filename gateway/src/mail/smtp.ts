/**
 * 极简 SMTP 客户端（零依赖）。
 *
 * 为什么自己写而不装 nodemailer：
 *  · 那台 2C2G 的机器上少一个依赖就少一份维护面
 *  · 我们只需要「发一封纯文本/简单 HTML 邮件」这一种能力
 *
 * 实测目标：阿里云 DirectMail `smtpdm.aliyun.com:465`（隐式 TLS + AUTH LOGIN）。
 * 该服务端**不支持 STARTTLS**，所以必须直接 tls.connect，不能用 587 明文升级。
 */
import { connect, type TLSSocket } from 'node:tls'

export type SmtpConfig = {
  host: string
  port: number
  user: string
  pass: string
  from: string
  fromName: string
  /** 纯发送服务没有收件箱，必须把回复引导到能读信的地址 */
  replyTo?: string
  timeoutMs: number
}

export type MailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export class SmtpError extends Error {
  readonly stage: string
  constructor(stage: string, message: string) {
    super(`[smtp:${stage}] ${message}`)
    this.name = 'SmtpError'
    this.stage = stage
  }
}

/** RFC 2047：中文主题必须编码，否则会乱码或被拒 */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`

/** 正文按 base64 编码 + 76 列折行：任何客户端都能正确显示，也不怕行首的点 */
const encodeBody = (value: string): string => {
  const base64 = Buffer.from(value, 'utf8').toString('base64')
  return (base64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/** DATA 阶段的行首点必须转义，否则会被当成结束标记 */
const dotStuff = (value: string): string => value.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')

type Reply = { code: number; lines: string[] }

/**
 * 一个请求/响应式的 SMTP 会话。
 * SMTP 的响应可能多行（`250-...` 续行，`250 ...` 结束），必须逐行读到空格分隔那行才算完。
 */
class Session {
  private socket: TLSSocket
  private buffer = ''
  private pending: Reply[] = []
  private waiter: ((reply: Reply) => void) | null = null
  private failure: Error | null = null

  constructor(socket: TLSSocket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let index = this.buffer.indexOf('\r\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 2)
        this.handleLine(line)
        index = this.buffer.indexOf('\r\n')
      }
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new SmtpError('socket', '连接被关闭')))
  }

  private current: Reply | null = null

  private handleLine(line: string) {
    const match = /^(\d{3})([ -])(.*)$/.exec(line)
    if (!match) {
      return
    }
    const code = Number(match[1])
    const final = match[2] === ' '
    if (!this.current) {
      this.current = { code, lines: [] }
    }
    this.current.code = code
    this.current.lines.push(match[3])
    if (final) {
      const reply = this.current
      this.current = null
      if (this.waiter) {
        const resolve = this.waiter
        this.waiter = null
        resolve(reply)
      } else {
        this.pending.push(reply)
      }
    }
  }

  private fail(error: Error) {
    if (this.failure) {
      return
    }
    this.failure = error
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve({ code: 0, lines: [error.message] })
    }
  }

  next(): Promise<Reply> {
    if (this.failure) {
      return Promise.resolve({ code: 0, lines: [this.failure.message] })
    }
    const queued = this.pending.shift()
    if (queued) {
      return Promise.resolve(queued)
    }
    return new Promise<Reply>((resolve) => {
      this.waiter = resolve
    })
  }

  async command(line: string, stage: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`)
    const reply = await this.next()
    if (reply.code === 0) {
      throw new SmtpError(stage, reply.lines.join(' '))
    }
    return reply
  }

  async expect(line: string, stage: string, codes: number[]): Promise<Reply> {
    const reply = await this.command(line, stage)
    if (!codes.includes(reply.code)) {
      throw new SmtpError(stage, `${reply.code} ${reply.lines.join(' ')}`)
    }
    return reply
  }

  close() {
    try {
      this.socket.end()
    } catch {
      // 已经断了就无所谓
    }
  }
}

const openSocket = (config: SmtpConfig): Promise<TLSSocket> =>
  new Promise((resolve, reject) => {
    const socket = connect(
      { host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true },
      () => resolve(socket)
    )
    socket.setTimeout(config.timeoutMs, () => {
      socket.destroy()
      reject(new SmtpError('connect', `连接 ${config.host}:${config.port} 超时`))
    })
    socket.once('error', (error) => reject(new SmtpError('connect', error.message)))
  })

/**
 * 发一封邮件。失败抛 SmtpError（调用方决定是"验证码发不出去"还是"静默记录"）。
 *
 * ⚠️ 不重试：邮件重复发送比失败更糟（用户会收到两个验证码，不知道该用哪个）。
 */
export const sendMail = async (config: SmtpConfig, message: MailMessage): Promise<void> => {
  const socket = await openSocket(config)
  const session = new Session(socket)
  try {
    const greeting = await session.next()
    if (greeting.code !== 220) {
      throw new SmtpError('greeting', `${greeting.code} ${greeting.lines.join(' ')}`)
    }

    await session.expect('EHLO freedeepseek', 'ehlo', [250])

    await session.expect('AUTH LOGIN', 'auth', [334])
    await session.expect(Buffer.from(config.user, 'utf8').toString('base64'), 'auth-user', [334])
    const auth = await session.command(Buffer.from(config.pass, 'utf8').toString('base64'), 'auth-pass')
    if (auth.code !== 235) {
      throw new SmtpError('auth-pass', `${auth.code} ${auth.lines.join(' ')}`)
    }

    await session.expect(`MAIL FROM:<${config.from}>`, 'mail-from', [250])
    await session.expect(`RCPT TO:<${message.to}>`, 'rcpt-to', [250, 251])
    await session.expect('DATA', 'data', [354])

    const headers = [
      `From: ${encodeHeader(config.fromName)} <${config.from}>`,
      `To: <${message.to}>`,
      ...(config.replyTo ? [`Reply-To: <${config.replyTo}>`] : []),
      `Subject: ${encodeHeader(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${config.from.split('@')[1] ?? 'localhost'}>`,
      'MIME-Version: 1.0',
      message.html
        ? 'Content-Type: multipart/alternative; boundary="=_ds_boundary"'
        : 'Content-Type: text/plain; charset=UTF-8',
      ...(message.html ? [] : ['Content-Transfer-Encoding: base64']),
    ]

    const body = message.html
      ? [
          '--=_ds_boundary',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          encodeBody(message.text),
          '--=_ds_boundary',
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          encodeBody(message.html),
          '--=_ds_boundary--',
        ].join('\r\n')
      : encodeBody(message.text)

    const payload = `${headers.join('\r\n')}\r\n\r\n${dotStuff(body)}\r\n.`
    const sent = await session.command(payload, 'body')
    if (sent.code !== 250) {
      throw new SmtpError('body', `${sent.code} ${sent.lines.join(' ')}`)
    }

    session.close()
  } catch (error) {
    session.close()
    throw error
  }
}

/** 从环境变量读配置；缺关键项返回 null（= 未启用邮件功能） */
export const readSmtpConfig = (env: NodeJS.ProcessEnv): SmtpConfig | null => {
  const host = env.SMTP_HOST ?? ''
  const user = env.SMTP_USER ?? ''
  const pass = env.SMTP_PASS ?? ''
  const from = env.SMTP_FROM ?? user
  if (!host || !user || !pass || !from) {
    return null
  }
  return {
    host,
    port: Number(env.SMTP_PORT ?? 465),
    user,
    pass,
    from,
    fromName: env.SMTP_FROM_NAME ?? '自由的deepseek',
    replyTo: env.SMTP_REPLY_TO,
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 20_000),
  }
}
