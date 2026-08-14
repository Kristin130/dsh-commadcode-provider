/**
 * Command Code catalog runtime: refresh (coalesced), offline cache fallback,
 * status tracking, and redacted diagnostics. Mirrors the behavior of
 * pi-commandcode-provider's `src/runtime.ts` adapted to the Harness: the
 * provider is registered once by the plugin; the runtime only feeds it the
 * current model catalog.
 *
 * @module dsh-commandcode-provider/runtime
 */

import { loadCommandCodeModels, type CommandCodeModel, type LoadCommandCodeModelsResult } from './models.ts'
import { resolveCatalog, type ResolvedCommandCodeOptions } from './config.ts'

export interface CommandCodeRuntimeStatus {
  source: LoadCommandCodeModelsResult['source']
  modelCount: number
  lastSuccess?: number
  lastAttempt?: number
  cachePath: string
  endpoint: string
  warning?: string
  refreshing: boolean
}

export interface CommandCodeRefreshResult {
  refreshed: boolean
  source: CommandCodeRuntimeStatus['source']
  modelCount: number
  warning?: string
}

const REDACTED = '[redacted]'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return REDACTED
  }
}

export function redactDiagnosticText(value: string): string {
  const redactedUrls = value.replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrl(match))
  return redactedUrls
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*[^\s,;)]+/gi, (match) => {
      const separator = match.match(/\s*[=:]\s*/)?.[0] ?? '='
      return `${match.slice(0, match.indexOf(separator))}${separator}${REDACTED}`
    })
}

export function redactEndpoint(value: string): string {
  return redactUrl(value)
}

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? 'never' : new Date(timestamp).toISOString()
}

export function formatCommandCodeStatus(status: CommandCodeRuntimeStatus): string {
  const lines = [
    `source: ${status.source}`,
    `model count: ${status.modelCount}`,
    `last success: ${formatTimestamp(status.lastSuccess)}`,
    `last attempt: ${formatTimestamp(status.lastAttempt)}`,
    `cache path: ${status.cachePath}`,
    `endpoint: ${redactEndpoint(status.endpoint)}`,
    `refresh: ${status.refreshing ? 'in progress' : 'idle'}`,
  ]

  lines.push(`warning: ${status.warning ? redactDiagnosticText(status.warning) : 'none'}`)
  return lines.join('\n')
}

export interface CommandCodeCatalogOptions {
  /** Live model list; defaults to the provider API through {@link loadCommandCodeModels}. */
  loadModels?: () => Promise<LoadCommandCodeModelsResult>
  logWarning?: (message: string) => void
  now?: () => number
}

/**
 * Owns the current Command Code model catalog: the last refresh result, its
 * offline-cache fallback, and coalesced refresh/status bookkeeping. The
 * adapter reads {@link getModels} per request; commands drive {@link refresh}.
 */
export class CommandCodeCatalog {
  private readonly now: () => number
  private readonly logWarning: (message: string) => void
  private options: ResolvedCommandCodeOptions
  private models: readonly CommandCodeModel[] = []
  private status: CommandCodeRuntimeStatus
  private refreshPromise: Promise<CommandCodeRefreshResult> | undefined

  constructor(
    options: ResolvedCommandCodeOptions,
    private readonly catalogOptions: CommandCodeCatalogOptions = {},
  ) {
    this.options = options
    this.now = catalogOptions.now ?? Date.now
    this.logWarning = catalogOptions.logWarning ?? ((message) => console.warn(`[commandcode] ${message}`))
    this.status = {
      source: 'empty',
      modelCount: 0,
      cachePath: options.modelsCachePath,
      endpoint: options.modelsUrl,
      refreshing: false,
    }
  }

  /** Reconfigure with a new resolved options snapshot. */
  reconfigure(options: ResolvedCommandCodeOptions): void {
    this.options = options
    // The cache path and endpoint may have moved; refresh status to match.
    this.status = { ...this.status, cachePath: options.modelsCachePath, endpoint: options.modelsUrl }
  }

  /** The current effective catalog (discovered + overrides), in discovery order. */
  getModels(): readonly CommandCodeModel[] {
    return this.models
  }

  /** One exact model, or undefined when the catalog does not know it. */
  getModel(modelId: string): CommandCodeModel | undefined {
    return this.models.find((model) => model.id === modelId)
  }

  getStatus(): CommandCodeRuntimeStatus {
    return { ...this.status }
  }

  /** Coalesced refresh: concurrent callers share one in-flight refresh. */
  refresh(): Promise<CommandCodeRefreshResult> {
    if (this.refreshPromise) return this.refreshPromise

    const refreshPromise = this.refreshCatalog().finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined
    })
    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  private async refreshCatalog(): Promise<CommandCodeRefreshResult> {
    this.status = {
      ...this.status,
      lastAttempt: this.now(),
      refreshing: true,
    }

    try {
      const loaded = await (this.catalogOptions.loadModels ?? (() =>
        loadCommandCodeModels({
          url: this.options.modelsUrl,
          cachePath: this.options.modelsCachePath,
          timeoutMs: this.options.modelsTimeoutMs,
        })))()
      const warning = loaded.warning ? redactDiagnosticText(loaded.warning) : undefined

      if (loaded.models.length > 0) {
        this.models = resolveCatalog(loaded.models, this.options)
        this.status = {
          ...this.status,
          source: loaded.source,
          modelCount: this.models.length,
          lastSuccess: this.now(),
          ...warning === undefined ? {} : { warning },
          refreshing: false,
        }
        if (warning) this.warn(warning)
        return {
          refreshed: true,
          source: loaded.source,
          modelCount: this.models.length,
          ...warning === undefined ? {} : { warning },
        }
      }

      const preservedWarning = warning ?? 'Model catalog refresh returned no models'
      this.status = {
        ...this.status,
        warning: preservedWarning,
        refreshing: false,
      }
      this.warn(preservedWarning)
      return {
        refreshed: false,
        source: loaded.source,
        modelCount: 0,
        warning: preservedWarning,
      }
    } catch (error) {
      const warning = redactDiagnosticText(
        `Could not refresh the Command Code model catalog: ${errorMessage(error)}`,
      )
      this.status = {
        ...this.status,
        warning,
        refreshing: false,
      }
      this.warn(warning)
      return {
        refreshed: false,
        source: this.status.source,
        modelCount: this.status.modelCount,
        warning,
      }
    }
  }

  private warn(message: string): void {
    try {
      this.logWarning(redactDiagnosticText(message))
    } catch {
      // Diagnostics must never make a catalog refresh fail.
    }
  }
}
