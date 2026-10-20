<div align="center">
  <h1>@cyanheads/us-drought-monitor-mcp-server</h1>
  <p><b>Query U.S. Drought Monitor severity, DSCI, population, and drought duration via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools (1 opt-in)</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/us-drought-monitor-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/us-drought-monitor-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/us-drought-monitor-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/us-drought-monitor-mcp-server/releases/latest/download/us-drought-monitor-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=us-drought-monitor-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXMtZHJvdWdodC1tb25pdG9yLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22us-drought-monitor-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fus-drought-monitor-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Weekly drought statistics from the [U.S. Drought Monitor](https://droughtmonitor.unl.edu/) (USDM) data services. Snapshot an area's current or dated severity, follow weekly history, rank states and counties, and count county weeks in drought across national, state, county, HUC watershed, tribal and climate-division geographies. Large results stage as tables for read-only SQL. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `drought_list_reference` | Browse drought categories, DSCI formulas, coverage and exact geography identifiers |
| `drought_get_current_severity` | Current or dated snapshot with area, square miles, population, DSCI and 4/52-week DSCI change |
| `drought_get_timeseries` | Weekly metrics and DSCI for explicit areas, with missing-data runs and peak summaries |
| `drought_compare_areas` | Rank states or counties by DSCI or D2+/D3+ coverage, or by change from a baseline week |
| `drought_get_weeks_in_drought` | County consecutive streaks or non-consecutive week counts at a drought category or worse |
| `drought_dataframe_describe` | Inspect a staged canvas: tables, columns, expiry and full producer metadata |
| `drought_dataframe_query` | Page read-only SQL over staged drought tables |
| `drought_dataframe_drop` | Remove one disposable staged table; opt-in via `DROUGHT_DATAFRAME_DROP_ENABLED=true` |

## Capability reference

### `drought_list_reference` <sub>tool</sub>

- `topic`: `categories`, `dsci`, `area_types`, `coverage`, `states`, `counties`, `tribal`, `climate_divisions` or `huc`; `nameContains` token filter, `state` for counties only, `hucLevel` (2, 4, 6 or 8) required for `huc`
- Up to 200 records per page (default 50), continued via `nextCursor` with unchanged filters; `totalCount` counts every match
- Records keep leading-zero identifiers and source vintages; `bundleVersion` and `sourceMetadata` (source URLs and SHA-256 hashes) date the offline bundle

---

### `drought_get_current_severity` <sub>tool</sub>

- One `area` (`areaType` + `aoi`, plus `hucLevel` for HUC; `aoi` takes an exact identifier or exact state or `"County Name, ST"` name); optional `date`, default the latest published map; `us` selects both CONUS and Total
- Each snapshot carries cumulative and categorical area percent, cumulative square miles, cumulative population (`populationStatus` `unsupported` outside US/state/county), `dsci`, and `dsciChange4Weeks` / `dsciChange52Weeks` against exactly 28 and 364 days earlier, each with an `available` / `missing` / `before_coverage` status
- A date outside published coverage returns `found: false` with `guidance`

---

### `drought_get_timeseries` <sub>tool</sub>

- 1–100 `areas` sharing one `areaType` and HUC level; inclusive `startDate` / `endDate`; `metric` `area_percent` (default), `area_sq_miles`, `population_percent` or `population_count` (US/state/county only); `statisticsType` `cumulative` (default) or `categorical`
- Rows carry the metric buckets plus `dsci`; `missingAreas`, `missingObservations` (date runs per metric and DSCI component) and per-area `summary` (every tied peak) cover the complete series
- Rows past the inline budget stage behind a preview, with the table in `staging`; optional `canvas_id` stages into an existing canvas. Metadata remains complete inline whenever it fits. Overflow automatically retains complete rows and metadata, including zero-observation results; `metadata_pages` gives each array's total, returned count and next offset

---

### `drought_compare_areas` <sub>tool</sub>

- `scope` `states` or `counties` (optional `state`, else nationwide); `metric` `dsci` (default), `d2_d4` or `d3_d4`; optional `date` (default latest) and `baselineDate` to rank the change; `direction` `desc` (default) or `asc`
- Competition ranks share ties; `excludedAreas` names each area missing its target or baseline value; `changeUnit` is `index` or `percentage_points`
- `limit` (1–200, default 20) sizes the inline preview; the complete ranking stages, with optional `canvas_id` reuse

---

### `drought_get_weeks_in_drought` <sub>tool</sub>

- `startDate`, `endDate`, `minCategory` (D0–D4) and `minWeeks` required; `mode` `consecutive` (default) or `non_consecutive`; `states` or one `county`, never both, or neither for nationwide counties
- Rows give `fips`, `county`, `state`, and either `startDate` / `endDate` / `consecutiveWeeks` or `nonConsecutiveWeeks`; a county qualifies when any part of it reaches the category or worse, and streaks are bounded by the requested window
- Consecutive `startMayExtendEarlier` and `endMayContinue` flag boundaries touching the effective window; they express uncertainty about continuation. The Monday end is compared with the final map Tuesday plus six days. Non-consecutive rows omit these flags
- Up to 200 rows per page (default 50); `nextCursor` stays valid five minutes with unchanged filters. Counts are duration statistics, not program eligibility

---

### `drought_dataframe_describe` <sub>tool</sub>

- `canvas_id` from a staging response; tables with SQL column types, row counts and expiry
- With `table_name`, that table's full producer metadata: requested and effective ranges, units, bucket-column mapping, missing data, summaries and provenance
- Oversized metadata returns bounded first pages with `metadata_pages`. To read a complete retained collection, supply `table_name`, `metadata_field` (`areas`, `summary`, `missingAreas`, `missingObservations`), `metadata_offset` and `metadata_limit` (1–100, default 20); follow `metadata_page.next_offset` until null. Pages read the same snapshot without fetching upstream again

---

### `drought_dataframe_query` <sub>tool</sub>

- `canvas_id` plus one SELECT, CTE or FROM-first expression without a terminal semicolon; writes, external reads and system catalogs are refused
- `limit` 1–500 (default 100) and `offset` up to 250,000; continue `next_offset` with identical SQL until null. `SELECT * FROM <table_name> ORDER BY row_id` returns the original rows in order
- `countIsExact` is true only when one page from offset 0 holds every row; use `SELECT COUNT(*)` for totals

---

### `drought_dataframe_drop` <sub>tool</sub>

- `canvas_id` and `table_name`; removes the analytical copy only, returning `dropped: false` when the table is already gone; an expired canvas fails as `canvas_not_found`
- Opt-in: absent from `tools/list` unless `DROUGHT_DATAFRAME_DROP_ENABLED=true`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USDM-specific:

- Fixed-origin client for the USDM data services (`usdmdataservices.unl.edu`): no key, at most 64 upstream requests and 64 MiB per call, three concurrent upstream requests, one retry that honors `Retry-After`
- Dates snap to the containing Tuesday–Monday map week; coverage starts 2000-01-04, and the latest map (usually published Thursday) is discovered from upstream
- Cumulative buckets (`d1_d4` = D1 or worse) overlap; categorical buckets (`d1_only`) are exclusive. DSCI is upstream's experimental 0–500 index, never recomputed
- Offline geography bundle: 52 states and jurisdictions, 3,230 counties (Connecticut planning regions included), 323 tribal areas, 357 climate divisions and 2,916 HUCs, refreshed by `scripts/update-reference-data.ts`
- Staged tables live in DuckDB with a 30-minute sliding lifetime renewed by queries; canvas tokens are tenant-scoped, shareable capabilities, so treat them as credentials
- At the four-canvas process cap, omitted-token staging reuses the tenant's most recently used service-owned canvas with a free slot (eight tables per canvas). Explicitly supplied canvases remain caller-owned; live tables are never evicted. `staging_capacity_exhausted` advises token reuse or expiry, while `staging_busy` advises waiting for active work. The two-workflow admission bound applies before fetching, including inline reads
- Connecticut's eight legacy county FIPS remain discoverable but are omitted from comparison populations. Their empty observation lookups explain that USDM serves Connecticut by planning region; call `drought_list_reference` with `topic: counties`, `state: CT`. Counties are never mapped onto different planning-region boundaries; `currentUsdm: false` alone is not a historical-coverage rule
- Node acquisition uses a private reusable Undici HTTP/1.1 dispatcher, released during server teardown; Bun retains native fetch

Agent-friendly output:

- Provenance on every response: `sourceUrls`, `retrievedAt`, the USDM `credit` line and the experimental-DSCI citation
- Missing data stays explicit: nulls with `dsciStatus` / `populationStatus`, `missingAreas`, `missingObservations` date runs and `excludedAreas`, never zero-filled
- Range and identity echo: `requestedRange` / `effectiveRange`, `latestMapDate`, `resolvedAreas`, and staging handles that name `drought_dataframe_describe` and `drought_dataframe_query`

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "us-drought-monitor-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/us-drought-monitor-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "us-drought-monitor-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/us-drought-monitor-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "us-drought-monitor-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/us-drought-monitor-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account; the USDM data services are public.
- Staging and SQL need native DuckDB, which the npm and Docker installs include. The Claude Desktop `.mcpb` bundle fixes `CANVAS_PROVIDER_TYPE=none`: references, snapshots and inline results work, and anything that must stage returns `canvas_unavailable`.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/us-drought-monitor-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd us-drought-monitor-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: set DROUGHT_DATAFRAME_DROP_ENABLED or canvas limits
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `DROUGHT_DATAFRAME_DROP_ENABLED` | Expose `drought_dataframe_drop` for disposable staged tables. | `false` |
| `CANVAS_PROVIDER_TYPE` | Analytical engine: `duckdb`, or `none` to disable staging and SQL. | `duckdb` |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | Memory limit per canvas engine. | `128` |
| `CANVAS_MAX_CANVASES_PER_TENANT` | Provider canvas cap; the server separately admits four live canvases per process. | `4` |
| `CANVAS_DEFAULT_ROW_LIMIT` | Provider query row cap; at least `501` when the canvas is enabled. | `10000` |
| `CANVAS_TTL_MS` | Sliding canvas lifetime, in ms; staged tables expire after 30 minutes without use. | `86400000` |
| `CANVAS_ABSOLUTE_CAP_MS` | Absolute canvas lifetime, in ms. | `604800000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t us-drought-monitor-mcp-server .
docker run --rm -p 127.0.0.1:3010:3010 us-drought-monitor-mcp-server
```

The image runs on Bun with native DuckDB, defaults to HTTP on port 3010 in stateless session mode, and logs to `/var/log/us-drought-monitor-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eight drought and dataframe tools. |
| `src/services/drought` | USDM client, geography resolution, map-week dates, workflows, staging and rendering. |
| `src/services/canvas-accessor.ts` | Access to the framework DataCanvas configured at startup. |
| `src/config` | Canvas defaults and the opt-in table-removal flag. |
| `src/data` | Generated geography reference bundle (`reference.json`). |
| `scripts/update-reference-data.ts` | Maintainer refresh of the reference bundle from official sources. |
| `tests/` | Unit, contract and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Service errors carry the `reason` declared in each tool's inline `errors[]` contract
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.

DSCI: Akyuz, F. A. 2017. *Drought Severity and Coverage Index*. United States Drought Monitor.
