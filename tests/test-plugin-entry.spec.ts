import { describe, expect, it, vi } from 'vitest'
import { apply, name, inject, PROVIDER, defaultModelsCachePath } from '../index.ts'
import { Config } from '../src/config.ts'

/**
 * Boot the plugin against a stub ctx to prove the full wiring path: provider
 * route registration, configurable-provider directory, model discovery, and
 * command registration all mount without throwing.
 */
function stubContext() {
  const registrations: { providers: string[]; adapter: unknown }[] = []
  const directory: unknown[] = []
  const discovery: { ns: string; fn: unknown }[] = []
  const commands: { name: string }[] = []
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }

  const ctx: any = {
    logger,
    get: (key: string) => {
      if (key === 'credentials') return {
        resolve: async () => ({ value: 'user_stub_key', source: 'file' }),
        set: vi.fn(),
      }
      if (key === 'commands') return { register: (def: { name: string }) => { commands.push(def) } }
      if (key === 'attachments') return undefined
      if (key === 'userQuestions') return undefined
      if (key === 'launchEnvironment') return undefined
      return undefined
    },
    inject: (_deps: string[], cb: (sctx: any) => void) => {
      const scope = {
        settings: {
          register: (_ns: string, schema: (value: unknown) => unknown, opts: any) => {
            // Resolve the schema so registrations behave like the real seam.
            const resolved = schema({}) as Record<string, unknown>
            const value = { ...(opts?.base ?? {}), ...resolved }
            return {
              get: () => value,
              watch: () => () => {},
              update: async () => {},
              replace: async () => {},
            }
          },
        },
        effect: () => () => {},
      }
      cb(scope)
    },
    llm: {
      registerAdapter: (providers: string[], adapter: unknown) => {
        registrations.push({ providers, adapter })
        const handle: any = () => {}
        handle.replace = () => {}
        return handle
      },
      registerConfigurableProviders: (entries: unknown[]) => {
        directory.push(...(entries as unknown[]))
        const handle: any = () => {}
        handle.replace = (next: unknown[]) => { directory.length = 0; directory.push(...(next as unknown[])) }
        return handle
      },
      registerModelDiscovery: (ns: string, fn: unknown) => {
        discovery.push({ ns, fn })
        return () => {}
      },
    },
  }
  return { ctx, registrations, directory, discovery, commands }
}

describe('dsh-commandcode-provider plugin entry', () => {
  it('declares its identity', () => {
    expect(name).toBe('commandcode-provider')
    expect(inject).toContain('llm')
    expect(PROVIDER).toBe('commandcode')
  })

  it('registers the provider route, directory entry, discovery, and commands', () => {
    const { ctx, registrations, directory, discovery, commands } = stubContext()
    apply(ctx, {})
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.providers).toEqual(['commandcode'])
    expect(directory).toEqual([
      { provider: 'commandcode', displayName: 'Command Code', settingsNs: 'commandcode-provider', settingsPath: [] },
    ])
    expect(discovery).toHaveLength(1)
    expect(discovery[0]?.ns).toBe('commandcode-provider')
    const names = commands.map((c) => c.name).sort()
    expect(names).toEqual(['commandcode-login', 'commandcode-refresh', 'commandcode-status'])
  })

  it('refuses an invalid composition entry', () => {
    const { ctx } = stubContext()
    expect(() => apply(ctx, { defaultContextWindow: -5 } as unknown as Config)).toThrow(/defaultContextWindow/)
  })

  it('computes the default cache path under the DSH home', () => {
    expect(defaultModelsCachePath()).toMatch(/commandcode-models\.json$/)
  })
})
