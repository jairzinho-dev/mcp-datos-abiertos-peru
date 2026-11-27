import { defineConfig } from 'vite';

// La app vive en app/ y se compila a dist/, que Capacitor copia al proyecto Android.
export default defineConfig({
  root: 'app',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2000 },
});
