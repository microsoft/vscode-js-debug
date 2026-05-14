declare module 'got' {
  // got v15 exposes types only through package exports, which TS can't resolve here
  // under the repo's current moduleResolution setting.
  export { default } from 'got/dist/source/index.js';
  export * from 'got/dist/source/index.js';
}
