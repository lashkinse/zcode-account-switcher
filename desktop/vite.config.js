import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite only builds the renderer (React frontend)
// The main process (main.js / preload.js) is pure Node and does not go through Vite
export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
