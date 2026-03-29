// Build-time version info injected by Vite's `define` in web/vite.config.ts.
declare const __APP_VERSION__: string;
declare const __APP_BUILD_DATE__: string;

// Vite asset imports: `import url from './file?url'` resolves to a string URL at build time.
declare module '*?url' {
  const src: string;
  export default src;
}

// Vite worker URL imports: bundles the file as a worker entry point and returns the URL.
declare module '*?worker&url' {
  const src: string;
  export default src;
}
