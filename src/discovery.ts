/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * The Command Code route is answered from the plugin's live catalog (fetched
 * from the Provider API and cached), never over a per-draft network call:
 * the catalog carries capacities a listing endpoint would not disclose, and
 * the endpoint is fixed to Command Code's own. The reply is candidate
 * metadata the surface offers for adoption; `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * @module dsh-commandcode-provider/discovery
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type { CommandCodeModel } from './models.ts'

/** The single provider route this plugin owns. */
export const PROVIDER = 'commandcode'

/**
 * Interrogate the Command Code provider for its advertised models.
 * @param request - the draft being edited; only the `commandcode` route is served.
 * @param catalog - current effective catalog reader.
 * @returns the advertised models in catalog order.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  catalog: () => readonly CommandCodeModel[],
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.provider !== PROVIDER) {
    throw new LlmError(
      `commandcode-provider owns a single route ("${PROVIDER}"); its models come from the live Provider API catalog`,
      'DISCOVERY_FAILED',
    )
  }
  return catalog().map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
}
