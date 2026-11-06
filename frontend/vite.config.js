import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../frontend-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // TrimbleImport imports the shared column matcher from ../src/lib.
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
})
