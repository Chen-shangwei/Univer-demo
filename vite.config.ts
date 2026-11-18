import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Univer 各包都依赖 rxjs，必须保证全局只有同一份实例
    dedupe: ['rxjs'],
  },
  server: {
    // M3 前端联调：/api 同源转发到 Fastify 后台（默认 8787），浏览器视角无跨域
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
