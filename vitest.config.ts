import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@provia/types': resolve(__dirname, 'packages/types/src/index.ts'),
      '@provia/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: { environment: 'node', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'] },
});
