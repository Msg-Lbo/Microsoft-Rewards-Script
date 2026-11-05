import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html') // 面板页面绝对路径
const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1' // 监听地址，默认仅本机
const PORT = Number(process.env.DASHBOARD_PORT ?? 3011) // 监听端口

/**
 * 极简静态服务器：只提供面板页面，数据一律由浏览器直连控制 API
 * @param {http.IncomingMessage} req - 请求
 * @param {http.ServerResponse} res - 响应
 */
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname // 请求路径

    if (pathname === '/' || pathname === '/index.html') {
        try {
            const html = fs.readFileSync(PAGE) // 面板 HTML 内容
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            return res.end(html)
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            return res.end(`读取面板页面失败: ${error.message}`)
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 未找到')
})

server.listen(PORT, HOST, () => {
    console.log(`[面板] 已启动 → http://${HOST}:${PORT}`)
    console.log(`[面板] 数据源 → ${process.env.CONTROL_API_URL ?? 'http://127.0.0.1:3010'}`)
    console.log('[面板] 如控制 API 启用了 token，访问时追加 ?token=你的token 即可')
})

server.on('error', error => {
    console.error(`[面板] 启动失败: ${error.message}`)
    process.exit(1)
})
