import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appJson = JSON.parse(readFileSync(resolve(__dirname, '../app.json'), 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('react') || id.includes('react-dom')) return 'react-vendor'
          if (id.includes('@evenrealities/even_hub_sdk')) return 'evenhub-vendor'
          if (id.includes('html5-qrcode')) return 'qr-vendor'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5175,
  },
})
