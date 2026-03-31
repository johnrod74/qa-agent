import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    root: resolve(__dirname),
    include: ['tests/**/*.test.ts'],
    exclude: ['generated-tests/**', 'node_modules/**', 'dist/**'],
  },
});
