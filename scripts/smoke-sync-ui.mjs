/**
 * 「云端为主」同步的端到端 UI 冒烟测试（阶段 2）。
 *
 * 真浏览器 + 真网关 + 真 IndexedDB，验证三件只有在一起才能验证的事：
 *  1. 本地库为空时，会话列表仍然显示云端的会话（列表读 /sync/sessions）
 *  2. 断网发消息 → 消息标「待发送」，且**云端没有它**（服务端确认前不算发出）
 *  3. 恢复网络 → 自动补发（退避重试），云端出现这条会话
 *
 * 用法：node scripts/smoke-sync-ui.mjs
 * 产物：delivery/smoke/*.png（可直接看界面）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP = join(ROOT, 'app')
const DIST = join(APP, 'dist')
const SHOTS = join(ROOT, 'delivery', 'smoke')
const TOKEN = 'smoke-sync-token-0123456789abcdef'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/**
 * 端口全部现取空闲的：写死端口会被上一轮没退干净的 Chrome / 网关占住，
 * 于是测试"莫名失败"——而真正的原因是它连到了上一次留下的那个页面。
 */
const freePort = () =>
  new Promise((ok) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })

/** 清掉本脚本自己留下的 headless Chrome（命令行里带临时目录前缀），不碰用户正在用的浏览器 */
const killStaleChrome = () =>
  new Promise((done) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*ds-sync-ui-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    )
    ps.on('exit', () => done())
  })

await killStaleChrome()
const APP_PORT = await freePort()
const GATEWAY_PORT = await freePort()
const CDP_PORT = await freePort()

const tmp = mkdtempSync(join(tmpdir(), 'ds-sync-ui-'))
mkdirSync(SHOTS, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now()
  for (;;) {
    if (await fn()) {
      return true
    }
    if (Date.now() - start > timeoutMs) {
      console.log(`    （等待超时：${label}）`)
      return false
    }
    await sleep(250)
  }
}

// ── 1. 构建带测试网关地址的前端 ─────────────────────
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
      APP_VERSION: 'smoke',
    },
    stdio: 'inherit',
  }
)
await new Promise((r) => build.on('exit', r))

// ── 2. 网关（临时库） ───────────────────────────────
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
    // 上游 Key 只是个占位：冒烟只关心同步链路，聊天请求到上游必然 401（正好验证错误呈现）
    DEEPSEEK_API_KEY: 'dummy-upstream-key-for-smoke-test-000000',
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

const gw = async (path, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, ...(init.headers ?? {}) },
  })
  let json = {}
  try {
    json = await response.json()
  } catch {
    json = {}
  }
  return { status: response.status, json }
}

// ── 3. 静态服务 ─────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
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

// ── 4. Chrome ───────────────────────────────────────
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

const cdp = await (async () => {
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

/* 极简 CDP 客户端：只需要 evaluate / navigate / 网络模拟 / 截图 */
const ws = new WebSocket(cdp)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})
let nextId = 1
const pending = new Map()
const pageLogs = []
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
    return
  }
  // 页面里的 console / 未捕获异常是排查"卡住"的唯一线索
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
    pageLogs.push(`[${msg.params.type}] ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageLogs.push(`[exception] ${msg.params.exceptionDetails?.text ?? ''} ${msg.params.exceptionDetails?.exception?.description ?? ''}`)
  }
  // 只记同步相关的网络活动：卡住还是 401，一看就知道
  const netUrl = msg.params?.request?.url ?? msg.params?.response?.url ?? ''
  if (netUrl.includes('/sync/') || netUrl.includes('/auth/me')) {
    if (msg.method === 'Network.requestWillBeSent') {
      const body = msg.params.request.postData
      const ids = body ? (body.match(/"id":"([^"]+)"/g) ?? []).join(',') : ''
      pageLogs.push(
        `→ ${msg.params.request.method} ${netUrl.replace(/^https?:\/\/[^/]+/, '')}${ids ? ` ${ids}` : ''}`
      )
    } else if (msg.method === 'Network.responseReceived') {
      pageLogs.push(`← ${msg.params.response.status} ${netUrl.replace(/^https?:\/\/[^/]+/, '')}`)
    } else if (msg.method === 'Network.loadingFailed') {
      pageLogs.push(`✕ ${msg.params.errorText} ${netUrl.replace(/^https?:\/\/[^/]+/, '')}`)
    }
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((ok, reject) => {
    const id = nextId++
    pending.set(id, { resolve: ok, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params = {}) => send(method, params, sessionId)
await page('Page.enable')
await page('Runtime.enable')
await page('Network.enable')

// 语言固定成中文，断言才好写（必须在应用脚本之前执行）
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
    const detail =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed'
    throw new Error(String(detail).split('\n')[0])
  }
  return result.result?.value
}
const bodyText = () => evaluate('document.body.innerText')
const shoot = async (name) => {
  const { data } = await page('Page.captureScreenshot', { format: 'png' })
  const path = join(SHOTS, `${name}.png`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, Buffer.from(data, 'base64'))
  return path
}

const dumpDiagnostics = async () => {
  console.log('  —— 诊断 ——')
  try {
    console.log('  body:', (await bodyText()).replace(/\n/g, ' | ').slice(0, 400))
  } catch {
    console.log('  body: (读取失败)')
  }
  console.log('  网络/页面日志:', pageLogs.slice(-14).join(' | ') || '(无)')
  console.log('  网关日志:', gatewayLog.replace(/\n/g, ' | ').slice(-600))
}

const seedTitle = '云端种子会话'
const seedPayload = JSON.stringify({
  id: 'seed-cloud-1',
  title: seedTitle,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 30_000,
  messages: [],
  rootMessageId: null,
  memoryScope: 'local',
  pinned: true,
})

try {
  const gatewayReady = await waitFor(
    async () => {
      try {
        return (await gw('/health')).status === 200
      } catch {
        return false
      }
    },
    20_000,
    '网关就绪'
  )
  check('网关启动', gatewayReady)
  if (!gatewayReady) {
    console.log(gatewayLog.slice(-1500))
    throw new Error('gateway did not start')
  }

  // 云端先有一条会话（本地 IndexedDB 是空的）
  await gw('/sync/sessions', {
    method: 'POST',
    body: JSON.stringify({
      sessions: [
        {
          id: 'seed-cloud-1',
          title: seedTitle,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 30_000,
          pinned: true,
          fileIds: [],
          payload: seedPayload,
        },
      ],
    }),
  })

  await page('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` })
  const ready = await waitFor(
    async () => (await evaluate('Boolean(document.querySelector("textarea"))')),
    20_000,
    '应用渲染'
  )
  check('应用加载完成', ready)
  if (!ready) {
    throw new Error('app did not render')
  }

  /**
   * 附件上传走 PUT，而 PUT **一定触发 CORS 预检**。
   * 服务端 allow-methods 曾经漏了 PUT → 浏览器在预检就拒掉、服务端一个字节都收不到，
   * 症状是"会话全同步成功、附件永远 0 个"。这条断言就是盯这个的：
   * 用真浏览器从页面源发一次跨域 PUT，必须拿到 200。
   */
  const putProbe = await evaluate(
    `fetch('http://127.0.0.1:${GATEWAY_PORT}/sync/files/probe_file_0001', {
       method: 'PUT',
       headers: { 'x-api-key': ${JSON.stringify(TOKEN)}, 'Content-Type': 'application/octet-stream' },
       body: 'probe',
     }).then((r) => String(r.status)).catch((e) => 'ERR ' + e.message)`
  )
  check('浏览器跨域 PUT 能上传附件（CORS 允许 PUT）', putProbe === '200', putProbe)

  // ── 阶段 2-1：列表来自云端 ──────────────────────
  const listed = await waitFor(async () => (await bodyText()).includes(seedTitle), 15_000, '云端会话出现在列表')
  check('本地库为空时，列表仍显示云端会话', listed)
  if (!listed) {
    // 失败时把现场打出来：页面到底看到了什么、能不能直连网关
    console.log('  —— 诊断 ——')
    console.log('  body:', (await bodyText()).replace(/\n/g, ' | ').slice(0, 400))
    console.log(
      '  页面直连网关:',
      await evaluate(
        `fetch('http://127.0.0.1:${GATEWAY_PORT}/sync/sessions',{headers:{'x-api-key':${JSON.stringify(TOKEN)}}})           .then((r) => r.status + ' ' + r.statusText)
           .catch((e) => 'ERR ' + e.message)`
      )
    )
    console.log('  网关日志:', gatewayLog.replace(/\n/g, ' | ').slice(-600))
    console.log('  页面日志:', pageLogs.slice(-12).join(' | ') || '(无)')
    console.log(
      '  IndexedDB:',
      await evaluate(
        `indexedDB.databases().then((list) => JSON.stringify(list)).catch((e) => 'ERR ' + e.message)`
      )
    )
    console.log(
      '  settings:',
      await evaluate(
        `JSON.stringify({ origin: localStorage.getItem('chat-demo:api-origin'), key: (localStorage.getItem('chat-demo:api-key') ?? '').slice(0, 6) })`
      )
    )
  }
  const text1 = await bodyText()
  check('置顶分组显示（pinned 来自服务端）', text1.includes('置顶'), text1.slice(0, 200))

  /**
   * 同步成功后状态条必须自己消失。
   * 这条断言是补的：v0.17.0B 里收尾逻辑拿 `phase` 判"队列冲干净没有"，
   * 而那时 phase 恒为 syncing → 永远不报完成，顶部一直卡「正在同步…」。
   */
  const barGone = await waitFor(async () => {
    const text = await bodyText()
    return !text.includes('正在同步') && !text.includes('同步失败')
  }, 10_000, '同步结束后状态条消失')
  check('同步成功后顶部状态条自动消失（不卡「正在同步」）', barGone)
  await shoot('01-cloud-list')

  // ── 打开云端会话（正文按需下载，所以要先联网打开） ──
  const clicked = await evaluate(`(() => {
    const title = [...document.querySelectorAll('div')].find(
      (el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(seedTitle)}
    )
    if (!title || !title.parentElement) return false
    // 侧边栏一行的 onClick 在标题的父节点上
    title.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })()`)
  check('点开云端会话', clicked === true)
  const composerReady = await waitFor(
    async () => Boolean(await evaluate('Boolean(document.querySelector("textarea"))')),
    10_000,
    '输入框出现'
  )
  check('云端会话正文按需下载成功（输入框就绪）', composerReady)
  if (!composerReady) {
    await dumpDiagnostics()
  }
  await sleep(400)

  // ── 阶段 2-2：断网发消息 ────────────────────────
  await page('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  await sleep(600)

  // 打开种子会话，在它里面发消息


  const message = '断网时发的第 1 条'
  await evaluate(`(() => {
    const el = document.querySelector('textarea')
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(message)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  await sleep(300)
  await page('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })

  const pendingShown = await waitFor(
    async () => {
      const text = await bodyText()
      return text.includes('待发送') || text.includes('发送中')
    },
    8_000,
    '消息出现「待发送/发送中」'
  )
  check('离线发送后消息标记为待发送', pendingShown)
  await shoot('02-offline-pending')

  const cloudHasMessage = async (text) => {
    const rows = (await gw('/sync/sessions')).json.sessions ?? []
    for (const row of rows) {
      const detail = await gw(`/sync/session?id=${encodeURIComponent(String(row.id))}`)
      if (String(detail.json.payload ?? '').includes(text)) {
        return true
      }
    }
    return false
  }

  check('离线时云端没有这条消息（确认后才算发出）', !(await cloudHasMessage(message)))

  // ── 阶段 2-3：恢复网络后自动补发 ────────────────
  await page('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })

  const delivered = await waitFor(
    async () => cloudHasMessage(message),
    25_000,
    '云端收到离线消息'
  )
  check('恢复网络后自动补发成功', delivered)

  const chipGone = await waitFor(async () => {
    const text = await bodyText()
    return !text.includes('待发送')
  }, 10_000, '待发送标记消失')
  check('确认后「待发送」标记消失', chipGone)
  await shoot('03-after-retry')

  // ── 阶段 2-4：手动同步的状态必须能跨页面存活 ──────────
  /**
   * 用 CDP 的 Fetch 域把 /sync/sessions 拦住，让同步"卡住"——
   * 这样断言不依赖时序（否则要赌"300ms 内还没同步完"）。
   * 这条针对真实现象：点开始同步后关掉设置再打开，界面又变回"没在跑"。
   */
  const clickByText = (text) => `(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})
    btn?.click()
    return Boolean(btn)
  })()`

  await page('Fetch.enable', { patterns: [{ urlPattern: '*sync/sessions*' }] })
  await evaluate(clickByText('设置'))
  await sleep(400)
  await evaluate(clickByText('数据管理'))
  await sleep(400)
  const started = await evaluate(clickByText('开始同步'))
  check('点开设置并触发同步', started === true)
  await sleep(400)

  // 关掉设置（Modal 用 document 上的 Escape 关闭）
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  )
  await sleep(400)
  const afterClose = await bodyText()
  check(
    '关掉设置后，顶部状态条仍在显示同步进度',
    afterClose.includes('同步中') || afterClose.includes('正在推送'),
    afterClose.slice(0, 120)
  )

  // 重新打开设置：必须还是"同步中"，而不是变回"开始同步"
  await evaluate(clickByText('设置'))
  await sleep(400)
  await evaluate(clickByText('数据管理'))
  await sleep(400)
  const reopened = await bodyText()
  check(
    '重新打开设置仍显示同步中（状态没被卸载丢掉）',
    (reopened.includes('同步中') || reopened.includes('正在推送')) &&
      !reopened.includes('开始同步'),
    reopened.slice(0, 160)
  )
  await shoot('04-sync-survives-remount')
  await page('Fetch.disable')
} catch (error) {
  console.log('  ⚠️ 测试中断：', error instanceof Error ? error.message : error)
  await dumpDiagnostics()
  fail += 1
} finally {
  try {
    ws.close()
  } catch {
    // 已经关了
  }
  chrome.kill()
  // Windows 上 Chrome 会派生子进程，只 kill 父进程会留下占着端口的孤儿
  await killStaleChrome()
  gateway.kill()
  staticServer.close()
  await sleep(1500)
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // Chrome 还可能占着 user-data-dir，临时目录留给系统清理
  }
}

console.log(`\n${pass} 项通过，${fail} 项失败`)
console.log(`截图：${SHOTS}`)
if (fail > 0) {
  process.exitCode = 1
}
