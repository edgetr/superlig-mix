import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  envDir: resolve(__dirname, '..'),
  server: { host: '127.0.0.1', port: 5180, fs: { allow: [resolve(__dirname, '..')] } },
  build: {
    outDir: resolve(__dirname, '../dist'),
    rollupOptions: { input: { main: resolve(__dirname, 'index.html') } },
    target: 'es2022',
  },
});
