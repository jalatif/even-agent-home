import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
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
