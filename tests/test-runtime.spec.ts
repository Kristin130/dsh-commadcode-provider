import { describe, expect, it } from 'vitest'
import { CommandCodeCatalog, formatCommandCodeStatus } from '../src/runtime.ts'
import { resolveOptions } from '../src/config.ts'
import type { LoadCommandCodeModelsResult } from '../src/models.ts'

const options = () => resolveOptions({}, undefined, 'cache.json')

describe('CommandCodeCatalog', () => {
  it('loads models on refresh and tracks status', async () => {
    const catalog = new CommandCodeCatalog(options(), {
      loadModels: async (): Promise<LoadCommandCodeModelsResult> => ({
        models: [{ id: 'a/model', name: 'A (CC)', reasoning: false, contextWindow: 100_000, maxTokens: 65_536 }],
        source: 'live',
      }),
    })
    expect(catalog.getModels()).toEqual([])
    const result = await catalog.refresh()
    expect(result.refreshed).toBe(true)
    expect(result.modelCount).toBe(1)
    expect(catalog.getModels()).toHaveLength(1)
    expect(catalog.getModel('a/model')?.name).toBe('A (CC)')
    const status = catalog.getStatus()
    expect(status.source).toBe('live')
    expect(status.modelCount).toBe(1)
    expect(status.refreshing).toBe(false)
    expect(status.lastSuccess).toBeDefined()
  })

  it('coalesces concurrent refreshes', async () => {
    let calls = 0
    const catalog = new CommandCodeCatalog(options(), {
      loadModels: async (): Promise<LoadCommandCodeModelsResult> => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { models: [{ id: 'x', name: 'X (CC)', reasoning: false, contextWindow: 10, maxTokens: 10 }], source: 'live' }
      },
    })
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()])
    expect(calls).toBe(1)
    expect(a.refreshed).toBe(true)
    expect(b.refreshed).toBe(true)
  })

  it('keeps the last good catalog when a refresh returns nothing', async () => {
    let first = true
    const catalog = new CommandCodeCatalog(options(), {
      loadModels: async (): Promise<LoadCommandCodeModelsResult> => {
        if (first) {
          first = false
          return { models: [{ id: 'k', name: 'K (CC)', reasoning: false, contextWindow: 10, maxTokens: 10 }], source: 'live' }
        }
        return { models: [], source: 'empty', warning: 'nothing available' }
      },
    })
    await catalog.refresh()
    const second = await catalog.refresh()
    expect(second.refreshed).toBe(false)
    expect(second.warning).toContain('nothing available')
    expect(catalog.getModels()).toHaveLength(1)
  })

  it('surfaces refresh failures in status without throwing', async () => {
    const catalog = new CommandCodeCatalog(options(), {
      loadModels: async (): Promise<LoadCommandCodeModelsResult> => { throw new Error('boom') },
    })
    const result = await catalog.refresh()
    expect(result.refreshed).toBe(false)
    expect(result.warning).toContain('boom')
    expect(catalog.getStatus().warning).toContain('boom')
  })
})

describe('formatCommandCodeStatus', () => {
  it('renders a redacted status block', () => {
    const text = formatCommandCodeStatus({
      source: 'live',
      modelCount: 3,
      lastSuccess: 0,
      lastAttempt: 0,
      cachePath: 'C:\\cache.json',
      endpoint: 'https://api.commandcode.ai/provider/v1/models',
      warning: 'could not reach https://user:secret@example.com/x?token=abc; Bearer sk-abcdef1234567890 failed',
      refreshing: false,
    })
    expect(text).toContain('source: live')
    expect(text).toContain('model count: 3')
    expect(text).not.toContain('secret')
    expect(text).toContain('[redacted]')
  })
})
