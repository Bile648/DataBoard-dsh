import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 看板独立跑在自己的端口，不去动 DSH 自身的 Web GUI（19387）
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
})
