import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [
      // Externalise everything in package.json EXCEPT @meza/core (workspace
      // package shipped as TypeScript sources — needs to be bundled so the
      // main process can load it at runtime).
      externalizeDepsPlugin({ exclude: ['@meza/core'] }),
    ],
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
