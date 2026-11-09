#!/usr/bin/env node
/**
 * 一键启动器（run.bat 调用）
 *
 * 流程：
 *   1. 确保控制 API（默认 3010）与监控面板（默认 3011）在运行，已在跑则复用
 *   2. 自动用默认浏览器打开监控页（带上 API 地址与 token，页面会记住）
 *   3. 通过 API 触发一次运行，并把关键日志回显到当前控制台
 *   4. 运行结束后面板保持可用，按 Enter 退出（最多等 15 分钟），退出时清理本次拉起的服务
 *
 * 之所以走 API 触发而不是直接 node dist/index.js：
 * 面板的日志/积分/状态来自 API 自己拉起的子进程，直接跑脚本面板会是空的。
 *
 * 用法：
 *   node scripts/main/launch.js           # 启动并监控
 *   node scripts/main/launch.js --stop    # 关闭常驻的 API / 面板服务
 *   node scripts/main/launch.js --help
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const IS_WIN = process.platform === 'win32'

const SERVICE_TIMEOUT_MS = 15000
const POLL_INTERVAL_MS = 1200
const START_GRACE_MS = 60000
const HOLD_OPEN_MS = 15 * 60 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 读取项目根目录的 .env（与 src/util/Load.ts 语义一致：已存在的环境变量优先）
 */
function loadEnvFile() {
    const envPath = path.join(ROOT, '.env')
    if (!fs.existsSync(envPath)) return

    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue

        const eq = trimmed.indexOf('=')
        if (eq === -1) continue

        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }

        if (process.env[key] === undefined) process.env[key] = value
    }
}

function envStr(name, fallback) {
    const value = process.env[name]
    if (value == null) return fallback
    const trimmed = String(value).trim()
    return trimmed || fallback
}

function isPortOpen(port, timeoutMs = 500) {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port })
        const done = result => {
            socket.destroy()
            resolve(result)
        }

        socket.setTimeout(timeoutMs)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false))
        socket.once('error', () => done(false))
    })
}

async function waitForPort(port, timeoutMs = SERVICE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await isPortOpen(port)) return true
        await sleep(250)
    }
    return false
}

/**
 * 确保某个后台服务在运行；已在运行则复用，不重复拉起
 * @returns {Promise<{ok: boolean, started: boolean, child: import('node:child_process').ChildProcess | null}>}
 */
async function ensureService(label, port, scriptRel) {
    if (await isPortOpen(port)) {
        console.log(`[服务] ${label} 已在运行（端口 ${port}），复用`)
        return { ok: true, started: false, child: null }
    }

    console.log(`[服务] 启动 ${label}（端口 ${port}）…`)

    const child = spawn(process.execPath, [path.join(ROOT, scriptRel)], {
        cwd: ROOT,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env
    })

    child.on('error', err => console.log(`[服务] ${label} 启动失败：${err.message}`))
    child.unref()

    if (!(await waitForPort(port))) {
        console.log(`[服务] ${label} 在 ${SERVICE_TIMEOUT_MS / 1000} 秒内未就绪`)
        return { ok: false, started: true, child }
    }

    console.log(`[服务] ${label} 就绪`)
    return { ok: true, started: true, child }
}

function openBrowser(url) {
    try {
        if (IS_WIN) {
            spawn('cmd.exe', ['/c', `start "" "${url}"`], { stdio: 'ignore', windowsHide: true })
        } else if (process.platform === 'darwin') {
            spawn('open', [url], { stdio: 'ignore' })
        } else {
            spawn('xdg-open', [url], { stdio: 'ignore' })
        }
    } catch (error) {
        console.log(`[面板] 打开浏览器失败：${error instanceof Error ? error.message : String(error)}`)
    }
}

function createApiClient(apiPort, token) {
    const base = `http://127.0.0.1:${apiPort}`

    return async function api(pathname, { method = 'GET', body } = {}) {
        const headers = {}
        if (token) headers.Authorization = `Bearer ${token}`
        if (body !== undefined) headers['Content-Type'] = 'application/json'

        const response = await fetch(`${base}${pathname}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        })

        const text = await response.text()
        let data
        try {
            data = text ? JSON.parse(text) : null
        } catch {
            data = text
        }

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status} ${data?.error ?? text}`)
            error.status = response.status
            error.code = data?.code
            throw error
        }

        return data
    }
}

function formatLog(entry) {
    const time =
        typeof entry.ts === 'string' && entry.ts.length >= 19
            ? entry.ts.slice(11, 19)
            : new Date().toLocaleTimeString('zh-CN', { hour12: false })

    const level = (entry.level ?? 'info').toUpperCase().padEnd(5)
    const prefix = [entry.platform, entry.title].filter(Boolean).join(' ')
    return `[${time}] ${level} ${prefix ? `[${prefix}] ` : ''}${entry.message ?? ''}`
}

/**
 * 服务不可用时的退路：直接跑脚本，行为和旧版 run.bat 一致
 */
function fallbackRun(reason) {
    console.log(`[启动] ${reason}，改为直接运行脚本（面板不可用）`)

    const child = spawn(IS_WIN ? 'npm.cmd' : 'npm', ['start'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: process.env
    })

    child.on('exit', code => process.exit(code ?? 0))
}

/**
 * 关闭常驻的 API / 面板服务
 */
function stopServices() {
    loadEnvFile()
    const ports = [Number(envStr('API_PORT', '3010')), Number(envStr('DASHBOARD_PORT', '3011'))]

    if (!IS_WIN) {
        console.log('[服务] --stop 目前只实现了 Windows 版本')
        return 0
    }

    for (const port of ports) {
        const script =
            `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
            `if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; 'stopped' } else { 'none' }`
        const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
        const outcome = (result.stdout ?? '').trim()
        console.log(outcome === 'stopped' ? `[服务] 已关闭端口 ${port}` : `[服务] 端口 ${port} 没有在运行`)
    }

    return 0
}

function printHelp() {
    console.log(`
微软奖励脚本启动器

用法：
  node scripts/main/launch.js           启动 API + 面板，打开监控页并跑一次
  node scripts/main/launch.js --stop    关闭常驻的 API / 面板服务
  node scripts/main/launch.js --help    显示本帮助

端口与鉴权读取 .env 中的 API_PORT / DASHBOARD_PORT / DASHBOARD_HOST / API_TOKEN。
`)
}

async function printSummary(api, status) {
    const points = await api('/points').catch(() => null)
    const totals = points?.totals

    console.log('')
    if (totals) {
        console.log(
            `[结果] 账户=${totals.accountsProcessed ?? '?'} | 获得积分=${totals.collected ?? '?'}` +
                ` | ${totals.oldTotal ?? '?'} → ${totals.newTotal ?? '?'}` +
                ` | 用时=${totals.runtimeMinutes ?? '?'} 分钟`
        )
    }

    const exit = status.lastExit
    if (exit) {
        console.log(`[结果] 退出码=${exit.code}${exit.signal ? ` | 信号=${exit.signal}` : ''}`)
        if (exit.error) console.log(`[结果] ${exit.error}`)
    }
}

/**
 * 运行结束后让面板继续可用，按 Enter 或超时后退出
 */
function holdPanelOpen(panelUrl) {
    if (!process.stdin.isTTY) return Promise.resolve()

    console.log('')
    console.log(`[面板] 仍在运行：${panelUrl}`)
    console.log('[面板] 按 Enter 退出（最多保持 15 分钟）')

    return Promise.race([
        new Promise(resolve => {
            process.stdin.resume()
            process.stdin.once('data', resolve)
            process.stdin.once('end', resolve)
        }),
        sleep(HOLD_OPEN_MS)
    ])
}

/**
 * 清理本次启动的服务；复用的服务保持不动
 */
async function cleanupServices(api, { apiService, panelService }) {
    if (apiService?.started) {
        await api('/shutdown', { method: 'POST', body: {} }).catch(() => {})
    }
    if (panelService?.started && panelService.child && !panelService.child.killed) {
        try {
            panelService.child.kill()
        } catch {}
    }
}

async function main() {
    const args = new Set(process.argv.slice(2))

    if (args.has('--help') || args.has('-h')) {
        printHelp()
        return 0
    }
    if (args.has('--stop')) {
        return stopServices()
    }

    loadEnvFile()

    const apiPort = Number(envStr('API_PORT', '3010'))
    const dashPort = Number(envStr('DASHBOARD_PORT', '3011'))
    const dashHost = envStr('DASHBOARD_HOST', '127.0.0.1')
    const token = envStr('API_TOKEN', '')
    const api = createApiClient(apiPort, token)

    const apiService = await ensureService('控制 API', apiPort, 'scripts/api/server.js')
    const panelService = await ensureService('监控面板', dashPort, 'scripts/api/dashboard-server.js')

    if (!apiService.ok || !panelService.ok) {
        await cleanupServices(api, { apiService, panelService })
        fallbackRun('监控服务启动失败')
        return 1
    }

    const panelUrl = `http://${dashHost}:${dashPort}`
    const pageUrl = `${panelUrl}/?api=${encodeURIComponent(`http://127.0.0.1:${apiPort}`)}${
        token ? `&token=${encodeURIComponent(token)}` : ''
    }`

    console.log(`[面板] ${panelUrl}`)
    openBrowser(pageUrl)

    const health = await api('/health').catch(error => {
        console.log(`[服务] API 健康检查失败：${error.message}`)
        return null
    })
    if (!health) {
        await cleanupServices(api, { apiService, panelService })
        fallbackRun('控制 API 不可用')
        return 1
    }

    // 记录启动前的日志位点，避免把上一次运行的缓冲日志全刷出来
    const before = await api('/status').catch(() => null)
    let lastLogId = before?.latestLogId ?? 0

    const onInterrupt = async () => {
        console.log('\n[运行] 收到中断，正在停止…')
        await api('/stop', { method: 'POST', body: {} }).catch(() => {})
        await sleep(2000)
        await cleanupServices(api, { apiService, panelService })
        process.exit(130)
    }
    process.on('SIGINT', () => void onInterrupt())
    process.on('SIGTERM', () => void onInterrupt())

    try {
        await api('/start', { method: 'POST', body: {} })
        console.log('[运行] 已通过 API 启动，日志会同步显示在监控页')
    } catch (error) {
        if (error.status === 409) {
            console.log('[运行] 已有任务在跑，改为只做监控')
        } else {
            console.log(`[运行] 启动失败：${error.message}`)
            await cleanupServices(api, { apiService, panelService })
            return 1
        }
    }

    // 等运行真正开始，避免把它当成「已结束」
    const startDeadline = Date.now() + START_GRACE_MS
    while (Date.now() < startDeadline) {
        const status = await api('/status').catch(() => null)
        if (status && status.state !== 'idle') break
        await sleep(500)
    }

    while (true) {
        const logs = await api(`/logs?afterId=${lastLogId}&level=info&limit=500`).catch(() => null)
        if (logs) {
            for (const entry of logs.logs) console.log(formatLog(entry))
            if (typeof logs.latestLogId === 'number') lastLogId = logs.latestLogId
        }

        const status = await api('/status').catch(() => null)
        if (status && status.state === 'idle') {
            await printSummary(api, status)
            await holdPanelOpen(panelUrl)
            await cleanupServices(api, { apiService, panelService })
            return status.lastExit?.code ?? 0
        }

        await sleep(POLL_INTERVAL_MS)
    }
}

main()
    .then(code => process.exit(code))
    .catch(error => {
        console.error(`[启动] 未预期的错误：${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
    })
