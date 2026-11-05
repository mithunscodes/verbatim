import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const quoteServer = { '/api': 'http://127.0.0.1:8787' }

export default defineConfig({
  plugins: [react()],
  server: { proxy: quoteServer },
  preview: { proxy: quoteServer },
})
