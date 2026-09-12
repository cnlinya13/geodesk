import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Public demo mode: the UI is unchanged, only the local API port changes. */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
      },
    },
  },
})
