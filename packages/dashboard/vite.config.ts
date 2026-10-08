import { defineConfig } from 'vite';

// In dev, the dashboard runs on :5173 and proxies API + WebSocket to the hub on :3000.
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
