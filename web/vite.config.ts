import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page static site: index.html (dashboard) and docs.html (how it works).
// `base: './'` keeps asset URLs relative so the build can be hosted at any path.
export default defineConfig({
  base: './',
  appType: 'mpa',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
      },
    },
  },
});
