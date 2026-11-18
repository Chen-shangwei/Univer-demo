/**
 * Fastify 实例装配。抽成工厂函数，便于 M1+ 的集成测试复用（同一 app 注入不同环境）。
 */
import Fastify from 'fastify'
import { registerRoutes } from './routes'

export function buildApp() {
  const app = Fastify({
    // M0 默认关闭请求日志，需要排查时设 APP_LOG=1
    logger: process.env.APP_LOG === '1',
  })
  registerRoutes(app)
  return app
}
