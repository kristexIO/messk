import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  // Relative assets keep static preview and simple Nginx hosting painless.
  base: './',
  build: {
    target: ['es2021', 'chrome105', 'safari15'],
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return;
          }
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
            return 'react-core';
          }
          if (id.includes('dexie')) {
            return 'data-layer';
          }
          if (id.includes('tweetnacl') || id.includes('bip39')) {
            return 'crypto-core';
          }
          if (id.includes('lucide-react') || id.includes('qrcode.react') || id.includes('react-hot-toast')) {
            return 'ui-kit';
          }
        },
      },
    },
  },
})
