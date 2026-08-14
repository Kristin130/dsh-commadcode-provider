import { describe, expect, it } from 'vitest'
import { calculateCommandCodeCost } from '../src/cost.ts'
import { MODEL_COSTS } from '../src/pricing.ts'
import type { ModelLike, Usage } from '../src/types.ts'

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  }
}

function model(id: string): ModelLike {
  return {
    id,
    api: 'commandcode-custom',
    provider: 'commandcode',
    maxTokens: 65536,
    cost: MODEL_COSTS[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

describe('calculateCommandCodeCost', () => {
  it('computes per-million-token costs with cache splits', () => {
    const u = usage({ input: 1_000_000, output: 500_000, cacheRead: 250_000, cacheWrite: 125_000 })
    calculateCommandCodeCost(model('deepseek/deepseek-v4-flash'), u)
    expect(u.cost.input).toBeCloseTo(0.14, 6)
    expect(u.cost.output).toBeCloseTo(0.14, 6)
    expect(u.cost.cacheRead).toBeCloseTo(0.0007, 6)
    expect(u.cost.cacheWrite).toBe(0)
    expect(u.cost.total).toBeCloseTo(0.2807, 6)
  })

  it('applies the highest crossed input tier', () => {
    const u = usage({ input: 300_000, output: 10_000 })
    const m = model('Qwen/Qwen3.7-Flash')
    calculateCommandCodeCost(m, u)
    // 256_000 tier: input 0.2, output 0.8, cacheRead 0.04, cacheWrite 0.25
    expect(u.cost.input).toBeCloseTo(0.06, 6)
    expect(u.cost.output).toBeCloseTo(0.008, 6)
  })

  it('zero cost for unknown models', () => {
    const u = usage({ input: 1_000_000 })
    calculateCommandCodeCost(model('brand-new/model'), u)
    expect(u.cost.total).toBe(0)
  })
})
