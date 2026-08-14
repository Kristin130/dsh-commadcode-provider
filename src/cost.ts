/**
 * Local cost calculation for Command Code usage.
 *
 * Mirrors pi-ai's `calculateCost` arithmetic exactly (the pi provider ships
 * its own copy because Oh My Pi's legacy pi-ai shim does not export it).
 * Kept here for parity with pi-commandcode-provider; the Harness LLM seam
 * does not surface cost today, but the usage objects this stream produces
 * carry the same numbers the pi plugin reports.
 *
 * @module dsh-commandcode-provider/cost
 */

import type { ModelLike, Usage } from './types.ts'

export function calculateCommandCodeCost(model: ModelLike, usage: Usage): void {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
  let rates = model.cost
  let matchedThreshold = -1
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }

  const longWrite = usage.cacheWrite1h ?? 0
  const shortWrite = usage.cacheWrite - longWrite
  usage.cost.input = (rates.input / 1_000_000) * usage.input
  usage.cost.output = (rates.output / 1_000_000) * usage.output
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}
