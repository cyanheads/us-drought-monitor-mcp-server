# Developer Protocol

**Server:** us-drought-monitor-mcp-server
**Version:** 0.2.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.18`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.4.0
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Identity:** npm package `@cyanheads/us-drought-monitor-mcp-server`; registry `io.github.cyanheads/us-drought-monitor-mcp-server`; display and machine names `us-drought-monitor-mcp-server`. The `createApp()` identity block contains `name` and `title` only.
- **Data scope:** read-only U.S. Drought Monitor statistics; staged DataCanvas tables are disposable analytical copies. Never report program eligibility from drought duration alone.
- **Local verification:** CLI probes and loopback servers only; never launch or drive GUI applications. Stop only the exact process IDs created by the run.
- **Git:** never stash, use worktrees, force-push, or discard uncommitted work. Editing agents do not commit, tag, or push.
- **Private design input:** `docs/idea.md` is excluded from Git, npm, bundles, and Docker inputs.
- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Workflow tools

The eight definitions live in `src/mcp-server/tools/definitions/`; `src/index.ts` registers seven by default and gates `drought_dataframe_drop` with `disabledTool`. The caller guide in `skills/us-drought-monitor-guide/SKILL.md` is served through skill resources; there are no prompts.

`drought_get_timeseries` admits work before fetching, passes a staging callback to the domain service, discloses missing observations, and renders the entire returned object:

```ts
async handler(input, ctx) {
  const result = await dataframeService.withAdmission(ctx, (stage) =>
    droughtService.timeseries(input, ctx.signal, stage),
  );
  if (!result.rowCount)
    ctx.enrich.notice(
      'No USDM observations are available for the resolved areas and published weeks; call drought_get_timeseries with a different range or drought_list_reference(topic=coverage).',
    );
  else if (result.missingObservations.length)
    ctx.enrich.notice(
      'Missing observations are disclosed by component and date; null DSCI does not mean zero drought.',
    );
  return result;
},
format: (result) => [{ type: 'text', text: renderWorkflow(result) }],
```

See the definition for its complete schemas, inline error contract and recovery hints. Preserve every output field on both `content[]` and `structuredContent`.

Time-series metadata stays complete inline when it fits. Overflow automatically retains complete metadata and rows (including zero-row tables), returning truthful array prefixes and `metadata_pages`. Read every retained collection through `drought_dataframe_describe` with `table_name`, `metadata_field`, `metadata_offset` and `metadata_limit`; never refetch upstream to serve a page. Retained metadata counts toward the same tenant byte quota and expires with its table.

Admission bounds acquisition before fetching, including inline results. Report active contention as `staging_busy`, with wait/retry guidance. At the four-canvas process cap, reuse only the caller tenant's most recently used service-owned canvas with fewer than eight live tables. Successful staging, querying and describing update that order. Explicit token reuse relinquishes service ownership; never evict live tables. Retained-capacity errors recommend token reuse or expiry and expose the earliest relevant expiry when known.

Duration acquisition sends one request per deduplicated state and merges all rows before county filtering or paging. Consecutive counts are bounded by the effective map window; `startMayExtendEarlier` and `endMayContinue` disclose uncertainty at its Tuesday start and Monday end. Keep non-consecutive rows free of these flags. Abort and settle all sibling requests on failure.

Only the eight legacy Connecticut FIPS `09001`, `09003`, `09005`, `09007`, `09009`, `09011`, `09013`, `09015` are excluded from comparisons. Preserve their discoverability and empty-success observation contracts, with planning-region guidance through `drought_list_reference(topic: counties, state: CT)`. Never generalize from `currentUsdm: false` or map county boundaries to planning regions.

### Reference bundle

`src/data/reference.json` is the generated offline geography bundle (states, counties, tribal areas, climate divisions, River Forecast Centers, HUCs) with source URLs, vintages and SHA-256 hashes. Refresh it only with `bun run scripts/update-reference-data.ts`, which downloads the official Census and USDM tables, validates them and writes the file atomically; never hand-edit it or fetch references at startup. `src/services/drought/reference-bundle.ts` encodes and decodes the stored form.

River Forecast Centers use `areaType: river_forecast_center` and reference topic `river_forecast_centers`; resolve official bundled codes or exact names, rejecting unknown RFCs locally. Validate metric `riverForecastCenterName` and DSCI `name` against the requested area. Support area percentages, square miles and DSCI; population stays unsupported. Supported population snapshots and population series carry `provenance.populationInterpretation` through retained describe/query metadata, preserving source precision and the official methodology link without inferring a census vintage.

Climate references include postal states from NOAA's contiguous climate codes plus USDM's verified 49xx Alaska mapping; never interpret climate prefixes as state FIPS. Reference state filters support counties and climate divisions. `parentHuc` selects descendants of an existing shorter level 2/4/6 parent before pagination; normalized parent and state filters bind cursors. Topic dependencies select both source metadata and provenance URLs, including mapping evidence and shared attribution/interpretation sources.

Reference records, query rows and describe columns share lossless JSON-cell table rendering. Explicit reference, duration, SQL and retained-metadata pages return the effective count, fewer only at exhaustion, with complete values regardless of width. Defaults are 25 for references/durations/SQL, 20 for comparison previews/metadata. Clamp positive integer reference/comparison/duration limits to 200, query limits to 500 and metadata limits to 100, populating optional `effectiveLimit` and `limitNotice` enrichment; retain all continuation. `DROUGHT_CLAMP_LIMITS=false` advertises and enforces maxima instead; clamps emit a request log and `drought.limit_clamps` counter. Size thresholds select producer staging and metadata prefixes only; singletons and fixed metadata never fail solely on output size. Without a provider, producers return complete inline results within acquisition limits, only when no explicit token was supplied. Keep acquisition, retention, tenant, expiry and capacity failures intact. Preserve blank optional dates and strict calendar validation. SQL normalization applies original-expression text gates, rejects multiple statements and positively identified writes, and removes only one terminal delimiter outside literals/comments; full provider parser and plan gates remain authoritative. Never restrict reads to a keyword allowlist.

### Configuration and startup

`src/config/canvas-config.ts` parses `DROUGHT_DATAFRAME_DROP_ENABLED` with `z.stringbool().default(false)` and `DROUGHT_CLAMP_LIMITS` with `z.stringbool().default(true)`. `src/config/load-env.ts` loads `.env` before tool schema construction; the entrypoint seeds only unset canvas defaults: DuckDB, 128 MB per engine, four canvases per tenant. Explicit `CANVAS_PROVIDER_TYPE=none` wins. An enabled engine requires `CANVAS_DEFAULT_ROW_LIMIT >= 501`.

`createApp()` uses `name` and `title` equal to `us-drought-monitor-mcp-server`, `sessionMode: 'stateless'`, and `setup(core) { setCanvas(core.canvas); }`. Description comes from `package.json`; instructions explain geography resolution, map weeks, missing data and analytical continuation.

Node acquisition uses the server-owned `usdmTransport` dispatcher with `allowH2: false`; `createApp.teardown` destroys it after intake stops. Bun uses native fetch. Do not change the global dispatcher or exception handlers.

## Context

| Property | Use |
|:---------|:----|
| `ctx.signal` | Cancels upstream acquisition and analytical operations. |
| `ctx.enrich` | Adds empty-result and missing-data notices, comparison totals and query truncation on both output surfaces. |
| `ctx.tenantId` | Scopes analytical admission and retained table metadata; unauthenticated callers share the default tenant. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # Identity, tool registration and canvas setup
  config/canvas-config.ts               # Analytical defaults and opt-in drop
  data/reference.json                   # Generated official geography bundle
  mcp-server/tools/definitions/         # Eight drought tool definitions
  services/canvas-accessor.ts           # Configured framework DataCanvas
  services/drought/
    drought-service.ts                  # Snapshots, series, rankings and duration
    dataframe-service.ts                # Admission, staging, metadata and SQL
    query-expression.ts                 # Original SQL text gates and terminal delimiter
    usdm-client.ts                      # Fixed-origin bounded HTTP acquisition
    reference-data.ts                   # Geography resolution and reference paging
    reference-bundle.ts                 # Bundle encoding and validation
    reference-schema.ts                 # Reference contracts
    dates.ts                            # Calendar validation and map-week arithmetic
    types.ts                            # Geography, metrics and provenance
    workflow-schema.ts                  # Public workflow output schemas
    format.ts                           # Lossless field rendering
    workflow-format.ts                  # Lossless workflow rendering
scripts/update-reference-data.ts        # Maintainer refresh of src/data/reference.json
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `drought-get-timeseries.tool.ts` |
| Tool/resource/prompt names | snake_case | `drought_get_timeseries` |
| Directories | kebab-case | `src/services/drought/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Get weekly drought observations.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-skill` | Author a skill the server publishes in root `skills/` for the agents that use it — when one earns its place, structure, validation, delivery |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean an inline-only `.mcpb` for Claude Desktop |
| `bun run start` | Run the compiled entrypoint with configured transport |
| `bun run test:coverage` | Run Vitest with coverage |
| `bun run release:github` | Create the GitHub release and upload its bundle |
| `bun run publish-mcp` | Authenticate the MCP publisher and publish the registry manifest |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces an inline-only `.mcpb` for Claude Desktop. The cleaner removes development dependencies, dependency-shipped agent docs and platform-specific native bindings. `manifest.json` explicitly fixes `CANVAS_PROVIDER_TYPE=none`: reference, snapshot and producer workflows return complete inline results within acquisition limits when no canvas token is supplied; explicit tokens and dataframe operations return `canvas_unavailable` with an npm/Docker installation hint. Keep the cleaner intact. npm and Docker include the production DuckDB dependency and default to the analytical provider.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a straight-through release PR** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One release run follows `git-wrapup` then `release-and-publish`: create `release/<version>` before committing, push the stack and open the PR, read checks and code-scanning alerts, then fast-forward `main` locally with `git merge --ff-only`, tag, push, and publish. Never merge through the GitHub UI or `gh pr merge`, and never rewrite pushed commits.

Publish to npm, the MCP Registry, GitHub Releases with the `.mcpb` bundle, and GHCR for `linux/amd64` and `linux/arm64`. Follow `framework-skills/release-and-publish/SKILL.md`, including `APP_VERSION` on the image build. Hosting is separate from package release.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { droughtService } from '@/services/drought/drought-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
