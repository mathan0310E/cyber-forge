import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@wolf-forge/shared-types': path.resolve(
        __dirname,
        '../../packages/shared-types/src',
      ),
    },
  },
});