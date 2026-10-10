import { defineConfig } from 'tsup';

export default defineConfig([{
  entry: ['src/index.ts', 'src/pdf-worker.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  dts: {
    entry: ['src/index.ts'],
    // tsup's declaration bundler uses baseUrl, deprecated in TypeScript 6.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  splitting: false,
  shims: true,
  clean: ['dist/index.*', 'dist/pdf-worker.*'],
}, {
  entry: ['src/browser.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  splitting: false,
  clean: ['dist/browser.*'],
}]);
