import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = process.env.DSH_PROGRESS_BACKEND ?? 'http://127.0.0.1:8787'

// 开发服务器独立跑在自己的端口，不去动 DSH 自身的 Web GUI（19387）。
// 接口全部走同源相对路径，开发时由这里的 proxy 转发到后端 —— 因此不需要 CORS，
// 与生产环境（后端同源托管静态资源）的行为完全一致。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/dsh': { target: BACKEND, changeOrigin: false },
      '/healthz': { target: BACKEND, changeOrigin: false },
    },
  },
  build: {
    // 直接产出到后端静态目录：前后端合成一个可部署单元
    outDir: '../server/static',
    emptyOutDir: true,
    sourcemap: false,
  },
})
