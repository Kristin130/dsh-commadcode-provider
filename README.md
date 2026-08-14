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

  No browser OAuth flow — the API key is entered directly in the web UI (**Settings → Models → Command Code → Edit**) or via `/commandcode-setkey`, and stored through the credential seam.
- **Commands** — `/commandcode-refresh` (coalesced re-fetch + re-register, keeps the last valid catalog on failure), `/commandcode-status` (redacted diagnostics: source, model count, timestamps, cache path, endpoint, warning), and `/commandcode-setkey` (paste an API key into the credential seam).
- **Pricing display** — the static per-model cost table from the pi plugin (USD per million tokens); cost arithmetic mirrors pi-ai's `calculateCost` exactly.
- **Error hygiene** — context-overflow wording is normalized to the Harness `CONTEXT_WINDOW_EXCEEDED` code, and every error/diagnostic text is redacted (bearer tokens, api keys, user tokens, URLs).

## Install

**小白友好：安装只要一条命令，插件会自动挂载，不用改任何配置文件。**

The package declares `dsh.bundle`, so `dsh plugin add` installs it AND automatically joins it to the profile's bundle layers — the shipped `cordis.patch.yml` mounts the provider row for you.

### 1. Install

From npm:

```sh
dsh plugin --profile <name> add dsh-commandcode-provider
```

Or from a local tarball / path / git URL:

```sh
npm pack    # → dsh-commandcode-provider-0.1.2.tgz
dsh plugin --profile <name> add ./path/to/dsh-commandcode-provider-0.1.2.tgz
# or: dsh plugin --profile <name> add ../dsh-commadcode-provider
# or: dsh plugin --profile <name> add git+https://github.com/Kristin130/dsh-commandcode-provider.git
```

> Do **not** also add a manual `cordis.patch.yml` row for this plugin — the bundle patch already mounts it; a second row would double-register the provider.

### 2. Restart dsh

The provider then appears in the web UI automatically.

### 3. Configure the API key

Open **Settings → Models → Command Code → Edit** in the web UI and paste your API key into the **API key** field (stored through the credential seam). No YAML, no browser auth flow, and **no API address to configure** — the default `https://api.commandcode.ai` endpoint is used automatically.

For reference, the underlying wiring (in case you prefer declarative config): the plugin's peers (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, …) are provided by the dsh host — profile installs use `autoInstallPeers: false`, so they resolve from the healed `$DSH_HOME/profiles/node_modules` fallback and every plugin shares the host's single cordis instance.

```yaml
# $DSH_HOME/settings.yaml
commandcode-provider:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference the Models page writes
```

## Authentication

### Web UI (recommended)

The API key is entered directly in **Settings → Models → Command Code → Edit** — a single **API key** field. There is no browser OAuth flow and no API address to fill in.

You can also run `/commandcode-setkey` in a chat and paste the key when prompted.

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
| `baseURL` | `COMMANDCODE_API_BASE` env → `https://api.commandcode.ai` | API base for `/alpha/generate` (usually leave at default) |
| `modelsUrl` | `COMMANDCODE_MODELS_URL` env → Provider API | Model discovery endpoint |
| `modelsTimeoutMs` | `COMMANDCODE_MODELS_TIMEOUT_MS` env → `10000` | Discovery timeout |
| `modelsCachePath` | `COMMANDCODE_MODELS_CACHE` env → `<dsh home>/commandcode/commandcode-models.json` | Catalog cache path |
| `models` | — | Optional explicit catalog entries; each overrides (or adds to) the discovered model by id |
| `defaultContextWindow` | `262144` | Context capacity for models neither the catalog nor an override sizes |
| `defaultMaxTokens` | `32768` | Output capability for models neither the catalog nor an override sizes |
| `timeoutMs` | — | Per-attempt HTTP request timeout |
| `streamIdleTimeoutMs` | `300000` | Max idle time while one stream read is outstanding |
| `retryPolicy` | normal defaults | Provider-owned model-request retry policy |

## Changelog

### 0.1.2

- **Removed the browser OAuth flow** (and the local callback server): no more `/commandcode-login`, no browser pop-up. The API key is entered directly in **Settings → Models → Command Code → Edit** (single API key field) or via `/commandcode-setkey`.
- Models-page card for Command Code shows only the **API key** field; the API address is not configurable there (the default endpoint is used).
- `/commandcode-login` is replaced by `/commandcode-setkey`.

### 0.1.0 / 0.1.1

- Initial port of `pi-commandcode-provider`: `/alpha/generate` streaming, model discovery + cache, reasoning efforts, image input, pricing display.

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
