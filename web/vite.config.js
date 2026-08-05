import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Builds into ../views/public, which Express serves as the site root.
// assetsDir is deliberately NOT the default "assets" — the Express app
// already owns /assets/icon.png as a distinct static route, and this
// avoids any collision between the two.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../views/public'),
    assetsDir: 'app-assets',
    emptyOutDir: true,
  },
});
