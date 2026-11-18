/**
 * 服务启动入口。M0：Fastify + 内存数据库（src/system/db 复用）。
 * 运行：pnpm server:dev（tsx watch） 或 pnpm server:start
 * 端口默认 8787（避开前端 vite 的 5173），可用 PORT / HOST 覆盖。
 */
import { buildApp } from './app'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = buildApp()

app
  .listen({ port: PORT, host: HOST })
  .then((addr) => {
    console.log(`[zn-tb-server] listening ${addr}`)
    console.log('[zn-tb-server] 冒烟： POST /api/auth/login  {"username":"rep_a","password":"123456"}')
    console.log('[zn-tb-server] 受保护： GET /api/summary/workbench  (Authorization: Bearer <token>)')
  })
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
