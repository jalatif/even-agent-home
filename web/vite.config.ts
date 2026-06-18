import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appJson = JSON.parse(readFileSync(resolve(__dirname, '../app.json'), 'utf-8'))

// HTTPS is opt-in for the dev server. The production app talks to its backend
// over plain HTTP (see the http-only `network` whitelist in app.json), and the
// simulator/fuzzy test harnesses probe `http://localhost:<port>`. Serving HTTPS
// unconditionally broke those harnesses — they could never complete the TLS
// handshake against a self-signed cert. Set HTTPS_DEV=1 to enable basicSsl
// (e.g. if you need to exercise a secure-context-only browser API locally).
const enableHttps = process.env.HTTPS_DEV === '1'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ...(enableHttps ? [basicSsl()] : [])],
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
