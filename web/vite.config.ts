import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://localhost:${process.env.HELM_PORT ?? 4400}`;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: true, proxy: { '/api': target, '/artifacts': target } },
});
