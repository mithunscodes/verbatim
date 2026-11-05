import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const quoteServer = { '/api': { target: 'http://127.0.0.1:8787', xfwd: true } }

const tunnelHosts = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev']

export default defineConfig({
  plugins: [react()],
  server: { host: true, proxy: quoteServer, allowedHosts: tunnelHosts },
  preview: { proxy: quoteServer, allowedHosts: tunnelHosts },
})
