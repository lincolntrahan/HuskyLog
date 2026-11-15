import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';

const CESIUM_SRC = resolve(__dirname, 'node_modules/cesium/Build/Cesium');
const CESIUM_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

/**
 * Serves Cesium's static runtime files (workers, assets, widget CSS) at /cesium/
 * in dev, and copies them into the renderer output on build. Everything is
 * local: the app never fetches Cesium assets from a CDN.
 */
function cesiumStatic(): Plugin {
  let outDir = '';
  return {
    name: 'huskylog-cesium-static',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const file = resolve(CESIUM_SRC, '.' + rel);
        if (!file.startsWith(CESIUM_SRC) || !existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of CESIUM_DIRS) cpSync(resolve(CESIUM_SRC, d), resolve(outDir, 'cesium', d), { recursive: true });
    },
  };
}

/**
 * Content-Security-Policy. Production allows only our own origins. Dev also
 * needs the Vite dev server's inline React-refresh preamble and its HMR socket.
 */
function csp(): Plugin {
  return {
    name: 'huskylog-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const dev = !!ctx.server;
        const self = "'self' hl-file: hl-tiles:";
        const policy = [
          `default-src ${self}`,
          `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}`,
          `worker-src 'self' blob:`,
          `style-src 'self' 'unsafe-inline'`,
          `img-src ${self} data: blob:`,
          `media-src ${self} blob:`,
          `font-src 'self' data:`,
          `connect-src ${self} data: blob:${dev ? ' ws://localhost:* http://localhost:*' : ''}`,
          `object-src 'none'`,
          `base-uri 'self'`,
        ].join('; ');
        return html.replace('%HL_CSP%', policy);
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: { CESIUM_BASE_URL: JSON.stringify('./cesium/') },
    plugins: [react(), cesiumStatic(), csp()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          popout: resolve(__dirname, 'src/renderer/popout.html'),
        },
      },
    },
    resolve: { alias: { '@core': resolve(__dirname, 'src/core') } },
  },
});
