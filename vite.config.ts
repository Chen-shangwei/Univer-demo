import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Univer 各包都依赖 rxjs，必须保证全局只有同一份实例
    dedupe: ['rxjs'],
  },
})
