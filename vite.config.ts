import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {
  LOCAL_RUNTIME_API_ORIGIN,
  LOCAL_RUNTIME_FRONTEND_PORT,
  LOCAL_RUNTIME_HOST,
} from './local-runtime-config.ts'

export default defineConfig({
  plugins: [react()],
  server: {
    host: LOCAL_RUNTIME_HOST,
    port: LOCAL_RUNTIME_FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: LOCAL_RUNTIME_API_ORIGIN,
      },
    },
  },
})
