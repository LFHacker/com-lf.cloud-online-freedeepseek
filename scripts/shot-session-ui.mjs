/**
 * 会话页排版截图（桌面 + 手机），用来肉眼核对"本对话累计"这类常驻信息的位置与密度。
 *
 * 为什么单独写一个脚本而不是靠人装 APK 看：
 *   这类改动 90% 的问题都是"多占了一行""折行难看""手机上挤"，
 *   在真机上试一圈要好几分钟，而这里 10 秒能出两张图，还能反复调。
 *
 *   node scripts/shot-session-ui.mjs
 * 产物：delivery/smoke/session-usage-{desktop,mobile}.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP = join(ROOT, 'app')
const DIST = join(APP, 'dist')
const SHOTS = join(ROOT, 'delivery', 'smoke')
const TOKEN = 'shot-ui-token-0123456789abcdef'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const tmp = mkdtempSync(join(tmpdir(), 'ds-shot-ui-'))
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((ok) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })

const killStaleChrome = () =>
  new Promise((done) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*ds-shot-ui-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    )
    ps.on('exit', () => done())
  })

await killStaleChrome()
const APP_PORT = await freePort()
const GATEWAY_PORT = await freePort()
const CDP_PORT = await freePort()

// ── 构建（指向本地网关）──────────────────────────────
console.log('构建前端…')
const build = spawn(
  process.execPath,
  [join(APP, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js'), 'build', '-c', 'rspack.config.ts'],
  {
    cwd: APP,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_API_ORIGIN: `http://127.0.0.1:${GATEWAY_PORT}`,
      DEV_API_KEY: TOKEN,
      APP_VERSION: 'shot',
    },
    stdio: 'inherit',
  }
)
await new Promise((r) => build.on('exit', r))

// ── 网关 ────────────────────────────────────────────
const gateway = spawn(process.execPath, ['src/index.ts'], {
  cwd: join(ROOT, 'gateway'),
  env: {
    ...process.env,
    PORT: String(GATEWAY_PORT),
    HOST: '127.0.0.1',
    GATEWAY_TOKEN: TOKEN,
    AUTH_DB_PATH: join(tmp, 'auth.db'),
    MEMORY_DATA_DIR: join(tmp, 'users'),
    ALLOW_INSTANCE_KEY: '1',
    DEEPSEEK_API_KEY: 'dummy-upstream-key-for-shot-000000',
    MEMORY_ENABLE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
gateway.stdout?.on('data', (c) => {
  gatewayLog += String(c)
})
gateway.stderr?.on('data', (c) => {
  gatewayLog += String(c)
})

const api = async (path, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, ...(init.headers ?? {}) },
  })
  return { status: response.status, json: await response.json().catch(() => ({})) }
}

// ── 静态服务 ────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
}
const staticServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const relative = url.pathname === '/' ? '/index.html' : url.pathname
  try {
    const body = await readFile(join(DIST, relative))
    res.writeHead(200, { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((r) => staticServer.listen(APP_PORT, '127.0.0.1', r))

// ── 造一条"聊过几轮"的会话（带真实 usage，费用才显示得出来）──
const now = Date.now()
// 真实 usage 形状（Anthropic 字段）：input_tokens 是**未命中**部分，
// cache_read_input_tokens 是命中部分 —— 写成 cacheHit/cacheMiss 会被 usageOf 判成"无用量"。
const usage = (cacheHit, cacheMiss, output) => ({
  input_tokens: cacheMiss,
  cache_read_input_tokens: cacheHit,
  output_tokens: output,
})
const session = {
  id: 'shot-session-1',
  title: '用户问候回应',
  createdAt: now - 600_000,
  updatedAt: now - 60_000,
  // ⚠️ 必须是首条消息的 id：null 在类型里表示"空会话"，而为 undefined 会触发线性化
  rootMessageId: 'm1',
  memoryScope: 'local',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: '你好',
      files: [],
      createdAt: now - 600_000,
      parentId: null,
      selectedChildId: 'a1',
    },
    {
      id: 'a1',
      role: 'assistant',
      parentId: 'm1',
      selectedChildId: 'm2',
      createdAt: now - 590_000,
      model: 'deepseek-flash',
      thinking: true,
      search: false,
      prefix: true,
      status: 'done',
      usage: usage(12_800, 1_600, 320),
      blocks: [
        { type: 'thinking', thinking: '用户只是打了个招呼，简短回应即可。' },
        { type: 'text', text: '你好！有什么我可以帮你的吗？' },
      ],
    },
    {
      id: 'm2',
      role: 'user',
      content: '帮我把这段项目的同步逻辑梳理一遍',
      files: [],
      createdAt: now - 300_000,
      parentId: 'a1',
      selectedChildId: 'a2',
    },
    {
      id: 'a2',
      role: 'assistant',
      parentId: 'm2',
      selectedChildId: null,
      createdAt: now - 280_000,
      model: 'deepseek-flash',
      thinking: true,
      search: false,
      prefix: true,
      status: 'done',
      usage: usage(38_400, 3_200, 1_240),
      blocks: [
        {
          type: 'text',
          text: '同步分三层：会话清单、正文按需下载、附件懒加载。清单以服务端为准，本地只做缓存。',
        },
      ],
    },
  ],
}

// ── Chrome ──────────────────────────────────────────
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(tmp, 'chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    '--lang=zh-CN',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const cdpUrl = await (async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
      if (info.webSocketDebuggerUrl) {
        return info.webSocketDebuggerUrl
      }
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  throw new Error('Chrome 没起来')
})()

const ws = new WebSocket(cdpUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)))
    } else {
      ok(msg.result)
    }
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((ok, reject) => {
    const id = nextId++
    pending.set(id, { resolve: ok, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

try {
  // 网关就绪
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await api('/health')).status === 200) {
        break
      }
    } catch {
      // 等
    }
    await sleep(150)
  }
  await api('/sync/sessions', {
    method: 'POST',
    body: JSON.stringify({
      sessions: [
        {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          pinned: false,
          fileIds: [],
          payload: JSON.stringify(session),
        },
      ],
    }),
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: pageId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params = {}) => send(method, params, pageId)
  await page('Page.enable')
  await page('Runtime.enable')
  await page('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('chat-demo:locale', 'zh-CN') } catch (e) {}`,
  })
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result?.value
  }
  const shoot = async (name) => {
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  📸 ${name}.png`)
  }

  await page('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` })
  // 等列表出现（刚导航时 body 可能还不存在）
  const bodyText = () => evaluate('document.body ? document.body.innerText : ""')
  for (let i = 0; i < 80; i += 1) {
    const text = await bodyText()
    if (text.includes(session.title)) {
      break
    }
    await sleep(250)
  }
  // 点开会话
  await evaluate(`(() => {
    const title = [...document.querySelectorAll('div')].find(
      (el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(session.title)}
    )
    title?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return Boolean(title)
  })()`)
  // 等正文下来
  for (let i = 0; i < 60; i += 1) {
    if ((await bodyText()).includes('有什么我可以帮你的吗')) {
      break
    }
    await sleep(250)
  }
  await sleep(600)
  await shoot('session-usage-desktop')

  // 设置 → 数据管理：确认「同步到云端」这一行的位置与文案
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '设置')
    btn?.click()
    return Boolean(btn)
  })()`)
  await sleep(500)
  const switched = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find(
      (el) => el.textContent.trim() === '数据管理'
    )
    tab?.click()
    return Boolean(tab)
  })()`)
  await sleep(500)
  console.log(`  设置面板：${switched ? '已切到数据管理' : '没找到数据管理 tab'}`)
  // 滚到设置内容底部：新加的「同步到云端」在账号与 Key 之后
  const scrolled = await evaluate(`(() => {
    const el = [...document.querySelectorAll('div')].find(
      (node) => node.scrollHeight > node.clientHeight + 50 && node.clientHeight > 200
    )
    if (!el) return false
    el.scrollTop = el.scrollHeight
    return true
  })()`)
  await sleep(400)
  console.log(`  设置内容滚动：${scrolled ? 'ok' : '没找到可滚动容器'}`)
  await shoot('settings-cloud-sync')

  // 手机尺寸：先桌面打开会话，再缩到 390x844（移动端抽屉是关着的，没法点列表）
  await page('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await sleep(800)
  await shoot('session-usage-mobile')
  await page('Emulation.clearDeviceMetricsOverride')
} catch (error) {
  console.log('  ⚠️ 出错：', error instanceof Error ? error.message : error)
  console.log(gatewayLog.slice(-800))
  process.exitCode = 1
} finally {
  try {
    ws.close()
  } catch {
    // 忽略
  }
  chrome.kill()
  await killStaleChrome()
  gateway.kill()
  staticServer.close()
  await sleep(1200)
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // 临时目录交给系统清理
  }
}
