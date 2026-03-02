// Vite asset imports: `import url from './file?url'` resolves to a string URL at build time.
declare module '*?url' {
  const src: string;
  export default src;
}
