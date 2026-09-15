import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // sql.js must stay in the dep pre-bundle: its browser entry is CJS/UMD, and with it
  // excluded the dev server serves the raw file, which has no ESM default export.
  // The .wasm is handled separately, imported as an asset URL and fed to locateFile.
  optimizeDeps: { include: ['sql.js'] },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
