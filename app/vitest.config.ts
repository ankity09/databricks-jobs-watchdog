import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.databricks/**'],
    // jest-dom matchers, and the browser pieces jsdom lacks. Client tests opt into jsdom with `// @vitest-environment jsdom`.
    setupFiles: ['./client/src/test/setup.ts'],
    // appkit-ui imports echarts-for-react/esm/core without a file extension, which Node's ESM loader rejects. Let Vite resolve it.
    server: { deps: { inline: ['@databricks/appkit-ui'] } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});
