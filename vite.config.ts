import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // sql.js ships a .wasm that must not be pre-bundled into an ESM chunk.
  optimizeDeps: { exclude: ['sql.js'] },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
