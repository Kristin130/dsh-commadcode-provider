import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Resolve the Harness seam packages from the local deepseek-harness checkout
// so tests exercise the exact API the plugin is written against (the
// published rc packages predate several seam helpers).
const harness = (rel: string) => fileURLToPath(new URL(rel, 'file:///D:/1codeprojects/deepseek-harness/'))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': harness('packages/llm/llm/src/index.ts'),
      '@deepseek-ai/dsh-settings': harness('packages/settings/settings/src/index.ts'),
      '@deepseek-ai/dsh-credentials': harness('packages/credentials/credentials/src/index.ts'),
      '@deepseek-ai/dsh-timeout': harness('packages/util/timeout/src/index.ts'),
      '@deepseek-ai/dsh-launch-environment': harness('packages/util/launch-environment/src/index.ts'),
      '@deepseek-ai/dsh-home-paths': harness('packages/util/home-paths/src/index.ts'),
      '@deepseek-ai/dsh-attachment': harness('packages/attachment/attachment/src/index.ts'),
      '@deepseek-ai/dsh-brand': harness('packages/util/brand/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
