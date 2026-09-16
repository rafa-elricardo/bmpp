import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The decision surface must stay fully exercised: this plugin's only
      // value is that its gates are provably correct.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})
