import { defineConfig } from 'tsup';

export default defineConfig({
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
  clean: true,
});
