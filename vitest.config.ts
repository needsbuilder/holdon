import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.mjs'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
