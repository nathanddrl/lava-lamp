import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Three.js pèse ~600 kB à lui seul.
    chunkSizeWarningLimit: 1000,
  },
});
