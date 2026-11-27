import { defineConfig } from 'vite';

// La app vive en app/ y se compila a dist/, que Capacitor copia al proyecto Android.
export default defineConfig({
  root: 'app',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // El worker de pdf.js se publica como .js: el servidor local de Capacitor no reconoce .mjs
        assetFileNames: (a) => (a.names?.[0] || a.name || '').endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
