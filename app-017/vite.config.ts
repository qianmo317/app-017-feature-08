import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    // e2e 由 Playwright 运行，vitest 只跑单元测试（默认 include 会扫到 e2e/*.ts）
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
