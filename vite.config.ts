import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/ai-town/',
  plugins: [react()],
  server: {
    allowedHosts: ['ai-town-your-app-name.fly.dev', 'localhost', '127.0.0.1'],
    // The model proxy holds the provider key (server/index.ts). Proxying it here keeps the
    // browser on a same-origin path, so nothing in the client needs a URL or a CORS exception.
    proxy: {
      '/llm': {
        target: process.env.MODEL_PROXY_URL ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
