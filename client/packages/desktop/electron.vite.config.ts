import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          picker: resolve(__dirname, 'src/preload/picker.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  // Renderer is intentionally minimal — @meza/web's pre-built output is copied
  // into out/renderer/ after this build. emptyOutDir is disabled to prevent
  // electron-vite from wiping the renderer directory if build ordering changes.
  renderer: {
    build: {
      emptyOutDir: false,
    },
  },
});
