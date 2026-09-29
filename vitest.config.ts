import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only the Trimble pipeline tests (src/trimble) run under vitest; the
    // modelbridge tests (src root + src/middleware) run under node --test.
    include: ['src/trimble/**/*.test.ts'],
  },
});
