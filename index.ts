/**
 * Command Code provider for DeepSeek Harness — a faithful port of
 * pi-commandcode-provider onto the Harness LLM seam.
 *
 * Registers the single `commandcode` provider route on `ctx.llm` with:
 * - the Command Code `/alpha/generate` streaming protocol (same wire format,
 *   retry/timeout/abort semantics, and message conversion as the pi plugin),
 * - live model discovery from the Provider API with an offline cache,
 * - per-model reasoning metadata and image-input modalities,
 * - credential resolution through the Harness credential seam, the
 *   `COMMANDCODE_API_KEY` environment, or the Command Code auth files,
 * - a configurable-provider directory entry and model discovery so the web
 *   Models page can configure and interrogate the provider,
 * - `/commandcode-refresh`, `/commandcode-status`, and `/commandcode-login`
 *   commands.
 *
 * @module dsh-commandcode-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandCodeAdapter } from './src/adapter.ts'
import { Config, resolveOptions } from './src/config.ts'
import type { ResolvedCommandCodeOptions } from './src/config.ts'
import { getApiKey } from './src/converters.ts'
import { PROVIDER, discoverModels } from './src/discovery.ts'
import { login } from './src/oauth.ts'
import { CommandCodeCatalog, formatCommandCodeStatus } from './src/runtime.ts'

export { CommandCodeAdapter } from './src/adapter.ts'
export type { CommandCodeAdapterOptions } from './src/adapter.ts'
export { Config } from './src/config.ts'
export type { CommandCodeModelProfile, ResolvedCommandCodeOptions } from './src/config.ts'
export { PROVIDER, discoverModels } from './src/discovery.ts'
export { CommandCodeCatalog, formatCommandCodeStatus, redactDiagnosticText } from './src/runtime.ts'
export { toCommandCodeContext, toStreamChunks } from './src/adapter.ts'

export const name = 'commandcode-provider'
export const inject = ['llm']

const NS = settingsNamespace('commandcode-provider')
const PKG = 'commandcode-provider'

/** Default catalog cache path under the Harness home. */
export function defaultModelsCachePath(): string {
  return join(resolveDshHome(), 'commandcode', 'commandcode-models.json')
}

/** Open a URL in the platform default browser, detached from the host. */
function openBrowser(url: string): void {
  const platform = process.platform
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
  } else if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
  }
}

/** Structural user-questions ask (optional service; avoids a hard peer import). */
interface UserQuestionsLike {
  ask(request: {
    questions: { id: string; question: string; header?: string }[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

/** Structural commands register (the dsh-commands service). */
interface CommandsLike {
  register(definition: {
    name: string
    description: string
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): void
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCommandCodeOptions | undefined
  const options = (): ResolvedCommandCodeOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw, launchEnvironmentOf(ctx), defaultModelsCachePath())
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('commandcode-provider: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  // Validate the composition entry immediately: an unserviceable entry fails
  // plugin load, exactly like llm-deepseek.
  options()

  const catalog = new CommandCodeCatalog(options(), {
    logWarning: (message: string) => ctx.logger.warn(message),
  })
  const catalogModels = (): ReturnType<CommandCodeCatalog['getModels']> => catalog.getModels()

  const resolveApiKey = async (connection: ResolvedCommandCodeOptions): Promise<string> => {
    // Credential seam first, then the trusted environment, then the Command
    // Code auth files — the same file support the pi plugin has.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined ? await credentials.resolve(ref) : undefined
    if (hit !== undefined) return assertUsableApiKey(hit.value, PKG, ref)
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) {
      return assertUsableApiKey(ambient.value, PKG, ref)
    }
    const fileKey = getApiKey({ env: {} })
    if (fileKey !== undefined) return fileKey
    throw new LlmError(
      `commandcode-provider: no Command Code API key for provider route "${PROVIDER}"; store ${ref} through`
      + ' the credentials service (the web Models page writes it), run /commandcode-login,'
      + ` or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CommandCodeAdapter({
    options,
    catalog: catalogModels,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })

  // The full directory is configurable from the moment the plugin mounts, so
  // the Models page can offer the route before any settings section exists.
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const facts = [{ provider: PROVIDER, displayName: options().displayName, settingsNs: NS, settingsPath: [] }]
    if (deepEqualJson(facts, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(facts)
    } else {
      directory.replace(facts)
    }
    directoryFacts = facts
  }
  ensureDirectory()

  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // Model discovery for the Models page "fetch available models" action.
  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, catalogModels))

  // Catalog reconfigure + refresh when discovery facts (endpoint/cache/timeout)
  // change through settings.
  let lastDiscoveryFacts: unknown
  const ensureCatalogFacts = (): void => {
    const next = options()
    const facts = {
      modelsUrl: next.modelsUrl,
      modelsCachePath: next.modelsCachePath,
      modelsTimeoutMs: next.modelsTimeoutMs,
    }
    if (deepEqualJson(facts, lastDiscoveryFacts)) return
    catalog.reconfigure(next)
    lastDiscoveryFacts = facts
    void catalog.refresh()
  }
  ensureCatalogFacts()

  const loginHandler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const connection = options()
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      return {
        kind: 'error',
        text: 'commandcode-provider: no credentials service is mounted; export COMMANDCODE_API_KEY or configure ~/.commandcode/auth.json instead',
      }
    }
    try {
      const stored = await login({
        onAuth: ({ url }) => openBrowser(url),
        onPrompt: async ({ message }) => {
          const userQuestions = ctx.get('userQuestions') as UserQuestionsLike | undefined
          if (userQuestions === undefined) {
            throw new Error(
              'Automatic browser transfer failed, and no interactive prompt is available;'
              + ' store the key via the web Models page or the COMMANDCODE_API_KEY environment variable',
            )
          }
          const answer = await userQuestions.ask({
            questions: [{ id: 'api-key', question: message, header: 'Command Code API key' }],
            agent: invocation.agent,
            signal: invocation.signal,
          })
          const item = answer.answers[0]
          const pasted = item?.custom ?? item?.selected[0]
          if (pasted === undefined || pasted.length === 0) throw new Error('No Command Code API key provided')
          return pasted
        },
      })
      await credentials.set(connection.apiKeyEnv, stored.access)
      return {
        kind: 'success',
        text: 'Authenticated with Command Code. The API key was stored through the credentials service.',
      }
    } catch (error: unknown) {
      return {
        kind: 'error',
        text: `Command Code login failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const commands = ctx.get('commands') as CommandsLike | undefined
  if (commands !== undefined) {
    commands.register({
      name: 'commandcode-refresh',
      description: 'Refresh the Command Code model catalog',
      handler: async () => {
        const result = await catalog.refresh()
        if (result.refreshed) {
          return {
            kind: 'success',
            text: `Command Code model catalog refreshed (${result.modelCount} models from ${result.source}).`,
          }
        }
        return {
          kind: 'error',
          text: `Command Code model catalog unchanged (${result.modelCount} models remain available).${result.warning ? ` ${result.warning}` : ''}`,
        }
      },
    })
    commands.register({
      name: 'commandcode-status',
      description: 'Show redacted Command Code provider diagnostics',
      handler: () => {
        const status = catalog.getStatus()
        return { kind: status.warning ? 'error' : 'success', text: formatCommandCodeStatus(status) }
      },
    })
    commands.register({
      name: 'commandcode-login',
      description: 'Authenticate with Command Code through the browser',
      handler: loginHandler,
    })
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // A refused settings generation keeps the previous routes and catalog
      // serving; each ensure* is contained so one failure cannot wedge the rest.
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('commandcode-provider: keeping the previously registered route after a refused update')
        ctx.logger.error(error)
      }
      try {
        ensureCatalogFacts()
      } catch (error) {
        ctx.logger.error('commandcode-provider: keeping the previous catalog facts after a refused update')
        ctx.logger.error(error)
      }
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('commandcode-provider: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })

  // Initial catalog load: live fetch with cached fallback; never fails boot.
  void catalog.refresh()
}
