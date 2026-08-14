# dsh-commandcode-provider

A custom LLM provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that connects dsh to the [Command Code](https://commandcode.ai) Provider API — a faithful port of [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) onto dsh's LLM seam.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account and API key or subscription. Command Code's terms, availability, and pricing apply.

## Functionality

Everything the pi plugin does, on the dsh host plane:

- **Provider registration** — registers the `commandcode` provider route on `ctx.llm` with the same `/alpha/generate` streaming protocol, request headers (`x-command-code-version`, `x-cli-environment`, `x-project-slug`, …), retry/timeout/abort semantics, and message/tool conversion as the pi plugin (including paired tool-call filtering, data-URL image forwarding, and legacy schema normalization).
- **Model discovery with offline cache** — fetches the current catalog from `https://api.commandcode.ai/provider/v1/models` and caches it at `<dsh home>/commandcode/commandcode-models.json` (versioned, atomic writes). If the endpoint is down, the last cached catalog keeps serving; on a first offline start the provider loads with zero models until a refresh succeeds.
- **Reasoning metadata** — models with known Command Code effort support advertise their thinking levels (e.g. `high`, `max` for deepseek models) through the LLM seam; a selected level is sent as the documented `params.reasoning_effort` field, while `off`, unsupported levels, and models without metadata omit it. Reasoning blocks stream into the Harness `reasoning` channel; they are never replayed to Command Code in later turns.
- **Image input** — models marked with the `image` modality in the command-code@1.15.1 catalog accept image blocks (resolved through dsh's durable attachment service); text-only models reject images before any network request.
- **Authentication** — credentials resolve per request through, in order:
  1. the Harness credential seam (`ctx.credentials`, what the web Models page writes),
  2. the trusted launch environment (`COMMANDCODE_API_KEY`),
  3. existing Command Code auth files: `~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json` (same shapes as the pi plugin).
  Plus `/commandcode-login`: a browser-assisted flow (local callback server on the CLI-compatible port, state-token CSRF check, paste fallback via `userQuestions`) that stores the returned API key through the credential seam.
- **Commands** — `/commandcode-refresh` (coalesced re-fetch + re-register, keeps the last valid catalog on failure) and `/commandcode-status` (redacted diagnostics: source, model count, timestamps, cache path, endpoint, warning).
- **Pricing display** — the static per-model cost table from the pi plugin (USD per million tokens); cost arithmetic mirrors pi-ai's `calculateCost` exactly.
- **Error hygiene** — context-overflow wording is normalized to the Harness `CONTEXT_WINDOW_EXCEEDED` code, and every error/diagnostic text is redacted (bearer tokens, api keys, user tokens, URLs).

## Install

The package installs through npm and loads inside dsh as a plain Cordis host plugin.

### 1. Install the package

From npm (once published):

```sh
dsh plugin --profile <name> add dsh-commandcode-provider
# or, from the profile directory directly:
# pnpm add dsh-commandcode-provider
```

Not published yet? Install the same way from a tarball, a local path, or a git URL:

```sh
npm pack                       # in the dsh-commandcode-provider checkout → dsh-commandcode-provider-0.1.0.tgz
dsh plugin --profile <name> add ./path/to/dsh-commandcode-provider-0.1.0.tgz
# or: dsh plugin --profile <name> add ../dsh-commadcode-provider
# or: dsh plugin --profile <name> add git+https://github.com/<you>/dsh-commandcode-provider.git
```

The plugin's peer dependencies (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, …) are provided by the dsh host; installs through the profile's pnpm workspace (`autoInstallPeers: false`) leave them to resolve from the healed `$DSH_HOME/profiles/node_modules` fallback, so every plugin shares the host's single cordis instance.

### 2. Compose the plugin

Add it to your profile's patch layer (`<profile dir>/cordis.patch.yml`, or `$DSH_HOME/cordis.patch.yml` to apply to every profile):

```yaml
- id: commandcode-provider
  name: 'dsh-commandcode-provider'
```

Restart dsh (or reload the profile), then configure the provider:

```yaml
# $DSH_HOME/settings.yaml
commandcode-provider:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference the Models page writes
```

Or use the web UI: the Models page shows the **Command Code** card (from the configurable-provider directory), stores the API key through the credential seam, and can fetch the live model catalog.

## Authentication

### Browser login

Run `/commandcode-login` in a chat. dsh opens the Command Code Studio auth page in your browser; after you authenticate, the API key is POSTed back to the local callback server and stored through the credential seam. If automatic transfer fails, the flow asks you to paste the key from the browser (via the `userQuestions` UI); if no interactive UI is mounted, it tells you to use the Models page or the environment variable instead.

### Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
```

### Auth file (existing Command Code / pi / OMP credentials)

The provider also reads existing credentials from:

- `~/.commandcode/auth.json`
- `~/.pi/agent/auth.json`
- `~/.omp/agent/auth.json`

Supported examples:

```json
{ "apiKey": "user_..." }
```

```json
{ "command-code": { "type": "api", "key": "user_..." } }
```

```json
{ "commandcode": "user_..." }
```

## Usage

Open the model picker and select one of the Command Code models (availability is refreshed from the Provider API when the plugin loads and via `/commandcode-refresh`). The provider advertises reasoning efforts only for models whose effort support is known, and image input only for models marked `image` in the bundled modality table.

## Configuration

The `commandcode-provider` settings section accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | Credential reference resolved per request |
| `displayName` | `Command Code` | Name shown by selectors |
| `baseURL` | `COMMANDCODE_API_BASE` env → `https://api.commandcode.ai` | API base for `/alpha/generate` |
| `modelsUrl` | `COMMANDCODE_MODELS_URL` env → Provider API | Model discovery endpoint |
| `modelsTimeoutMs` | `COMMANDCODE_MODELS_TIMEOUT_MS` env → `10000` | Discovery timeout |
| `modelsCachePath` | `COMMANDCODE_MODELS_CACHE` env → `<dsh home>/commandcode/commandcode-models.json` | Catalog cache path |
| `models` | — | Optional explicit catalog entries; each overrides (or adds to) the discovered model by id |
| `defaultContextWindow` | `262144` | Context capacity for models neither the catalog nor an override sizes |
| `defaultMaxTokens` | `32768` | Output capability for models neither the catalog nor an override sizes |
| `timeoutMs` | — | Per-attempt HTTP request timeout |
| `streamIdleTimeoutMs` | `300000` | Max idle time while one stream read is outstanding |
| `retryPolicy` | normal defaults | Provider-owned model-request retry policy |

## Development

```sh
npm install        # dev + test dependencies
npm run typecheck  # strict tsc against the harness seam sources
npm run build      # emit lib/ (ESM + declarations)
npm test           # vitest suite (wire protocol, discovery, cost, adapter, plugin entry)
```

The typecheck and vitest resolve the `@deepseek-ai/*` seam packages from a local `D:/1codeprojects/deepseek-harness` checkout via `tsconfig.json` paths / `vitest.config.ts` aliases; a published build only needs the peerDependencies a dsh host already provides.

## License

MIT
