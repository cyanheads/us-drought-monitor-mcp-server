<div align="center">
  <h1>@cyanheads/us-drought-monitor-mcp-server</h1>
  <p><b>Query U.S. Drought Monitor severity, DSCI, population, and drought duration via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (+1 opt-in) • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/us-drought-monitor-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/us-drought-monitor-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/us-drought-monitor-mcp-server) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/us-drought-monitor-mcp-server/releases/latest/download/us-drought-monitor-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=us-drought-monitor-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXMtZHJvdWdodC1tb25pdG9yLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik1DUF9UUkFOU1BPUlRfVFlQRSI6InN0ZGlvIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22us-drought-monitor-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fus-drought-monitor-mcp-server%22%5D%2C%22env%22%3A%7B%22MCP_TRANSPORT_TYPE%22%3A%22stdio%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Read weekly [U.S. Drought Monitor](https://droughtmonitor.unl.edu/) statistics, resolve geography identifiers, compare areas and count county weeks in drought. Coverage includes national areas, states, counties, HUC watersheds, tribal areas and climate divisions. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `drought_list_reference` | Browse drought definitions, coverage and geography identifiers |
| `drought_get_current_severity` | Current or dated snapshot with area, population and DSCI changes |
| `drought_get_timeseries` | Weekly metrics and DSCI for explicit areas, with missing-data summaries |
| `drought_compare_areas` | Rank states or counties by severity or baseline change |
| `drought_get_weeks_in_drought` | County consecutive streaks or non-consecutive qualifying week counts |
| `drought_dataframe_describe` | Inspect a supplied analytical canvas and its table metadata |
| `drought_dataframe_query` | Page read-only SQL over staged drought tables |
| `drought_dataframe_drop` | Remove one disposable table; opt-in via `DROUGHT_DATAFRAME_DROP_ENABLED=true` |

## Capability reference

Dates use `YYYY-MM-DD` and resolve to the containing Tuesday–Monday map week. Published coverage starts January 4, 2000; latest means the newest observed publication, usually released Thursday. Cumulative buckets overlap; categorical buckets are exclusive. DSCI is the upstream experimental 0–500 index. Missing values remain null, distinct from zero drought.

### `drought_list_reference` <sub>tool</sub>

- `topic`: `categories`, `dsci`, `area_types`, `coverage`, `states`, `counties`, `tribal`, `climate_divisions` or `huc`; `nameContains` filters before paging. `state` is county-only; `huc` requires `hucLevel` 2, 4, 6 or 8.
- `limit` 1–200 (default 50); follow `nextCursor` with unchanged filters. Records retain leading-zero identifiers, source vintages and acquisition evidence.

### `drought_get_current_severity` <sub>tool</sub>

- `area` contains `areaType` and `aoi`; HUC also requires `hucLevel`. Resolve exact identifiers with the reference tool. Optional `date` defaults to the latest published map.
- Returns cumulative and categorical area percentages, cumulative square miles, supported population counts, upstream DSCI and changes from exactly 4 and 52 weeks earlier. Population is available only for US/state/county; unsupported and missing observations have explicit statuses.
- The `us` selector resolves both CONUS and Total. Out-of-coverage or unavailable snapshots return `found: false` and guidance.

### `drought_get_timeseries` <sub>tool</sub>

- `areas` accepts 1–100 explicit selectors sharing one `areaType` and HUC level; `startDate` and `endDate` select inclusive map weeks.
- `metric`: `area_percent` (default), `area_sq_miles`, `population_percent` or `population_count`; `statisticsType`: `cumulative` (default) or `categorical`. Population supports US/state/county only.
- Returns complete rows inline or a preview plus `staging`, with requested/effective ranges, missing components and full-data summaries retaining every tied peak. Optional `canvas_id` reuses an earlier canvas.
- The 100-area schema cap is not a success guarantee: acquisition and metadata budgets apply independently. Even 100 county IDs over one week can exceed metadata limits; `dataset_too_large` asks for fewer areas or shorter ranges.

### `drought_compare_areas` <sub>tool</sub>

- `scope`: `states` or `counties`; optional `state` narrows counties, otherwise supported counties nationwide. Optional `date` defaults to the latest map; `baselineDate` ranks target minus exact baseline.
- `metric`: `dsci` (default), `d2_d4` or `d3_d4`; `direction`: `desc` (default) or `asc`; `limit` 1–200 (default 20) controls the preview, preserving the complete staged ranking.
- Equal values share competition rank; `excludedAreas` identifies missing sides. Changes use index units or percentage points. Optional `canvas_id` reuses a canvas.

### `drought_get_weeks_in_drought` <sub>tool</sub>

- Required `startDate`, `endDate`, `minCategory` D0–D4 and `minWeeks`; `mode`: `consecutive` (default) or `non_consecutive`.
- Supply `states` or one `county`, never both; omit both for supported nationwide counties. A county qualifies when any area reaches the category or worse. These counts do not establish program eligibility.
- `limit` 1–200 (default 50); follow `nextCursor` with unchanged filters within five minutes. Consecutive rows preserve full upstream streak boundaries.

### `drought_dataframe_describe` <sub>tool</sub>

- Required `canvas_id` from a producer; optional `table_name` returns its complete source-query, units, missing-data and provenance metadata. Omit the table for schema summaries.
- Returns SQL column types, row counts and expiry. It never enumerates other canvas tokens.

### `drought_dataframe_query` <sub>tool</sub>

- Required `canvas_id` and `sql`: one SELECT, CTE or FROM-first read expression without a terminal semicolon; writes, external reads and system catalogs are blocked.
- `limit` 1–500 (default 100), `offset` 0–250,000 (default 0). Response size may reduce the page; continue `next_offset` with identical SQL and stable ordering until null.
- Recover original rows with `SELECT * FROM <table_name> ORDER BY row_id`. For exact totals use `SELECT COUNT(*) FROM <table_name>`; `returnedCount` is the page count and `countIsExact` discloses completeness.

### `drought_dataframe_drop` <sub>tool</sub>

- Required `canvas_id` and `table_name`; removes the analytical copy only, returning `dropped: false` if the table is already absent. An absent or expired canvas returns `canvas_not_found`.
- Absent from `tools/list` unless `DROUGHT_DATAFRAME_DROP_ENABLED=true`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP, optional JWT/OAuth authentication, structured logging and OpenTelemetry.

- Source URLs, retrieval times, attribution and experimental DSCI citation accompany results.
- Complete staged datasets remain queryable beyond the inline preview. Tables have a sliding 30-minute lifetime renewed by queries; canvas tokens are shareable capabilities scoped to a tenant, so handle them as access credentials.
- Complete response metadata and acquisition have independent budgets. Requests that cannot fit fail with actionable errors rather than silently dropping data. Retry `staging_capacity_exhausted` later or reduce scope.
- `content[]` and `structuredContent` preserve the same public data.

## Getting started

### Local MCP client

Add one of these configurations to your MCP client. Bun ≥1.4.0 or Node.js ≥24 is required; npm and Docker installations provide native DuckDB for analytical workflows.

```json
{
  "mcpServers": {
    "us-drought-monitor-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/us-drought-monitor-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
    }
  }
}
```

Or with npx:

```json
{
  "mcpServers": {
    "us-drought-monitor-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/us-drought-monitor-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
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

### Claude Desktop bundle

The `.mcpb` install is **inline-only**: references, snapshots and bounded inline datasets work. Its manifest sets `CANVAS_PROVIDER_TYPE=none` because the portable bundle removes native DuckDB bindings. SQL tools remain visible but unavailable; results requiring staging return `canvas_unavailable`. Use npm or Docker for complete analytical workflows, including the default top-20 comparison when its remaining ranking must be staged.

The bundle exposes only log-level configuration. npm plugin installations also support `DROUGHT_DATAFRAME_DROP_ENABLED`: Claude Code prompts for it and the log level; Codex forwards both variables from your exported environment. The bundle intentionally omits table-removal and engine controls because it cannot create analytical tables.

### Examples

Find Washington counties with `drought_list_reference`:

```json
{"topic":"counties","state":"WA","nameContains":"King"}
```

Get a state snapshot with `drought_get_current_severity`:

```json
{"area":{"areaType":"state","aoi":"WA"}}
```

Get weekly county observations with `drought_get_timeseries`:

```json
{"areas":[{"areaType":"county","aoi":"53033"}],"startDate":"2024-01-02","endDate":"2024-02-27","metric":"area_percent","statisticsType":"cumulative"}
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `DROUGHT_DATAFRAME_DROP_ENABLED` | Expose disposable table removal. | `false` |
| `CANVAS_PROVIDER_TYPE` | Analytical engine; `none` disables staging/SQL. MCPB fixes this to `none`. | `duckdb` |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | Memory limit per canvas engine. | `128` |
| `CANVAS_MAX_CANVASES_PER_TENANT` | Provider cap; process admission independently caps live canvases at four. | `4` |
| `CANVAS_DEFAULT_ROW_LIMIT` | Provider query cap; must be at least 501 with canvas enabled. | `10000` |
| `CANVAS_TTL_MS` | Sliding canvas lifetime; per-table lifetime remains 30 minutes. | `86400000` |
| `CANVAS_ABSOLUTE_CAP_MS` | Absolute canvas lifetime. | `604800000` |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http`; Docker defaults to HTTP. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address; Docker binds `0.0.0.0`. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session posture. | `stateless` |
| `MCP_AUTH_MODE` | `none`, `jwt` or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Minimum log level. | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for optional auth, logging and telemetry settings. No upstream key or configurable API origin is needed.

## Running the server

```sh
git clone https://github.com/cyanheads/us-drought-monitor-mcp-server.git
cd us-drought-monitor-mcp-server
bun install
cp .env.example .env
bun run rebuild
bun run start:stdio
```

For Streamable HTTP, run `bun run start:http`; the local endpoint is `http://127.0.0.1:3010/mcp`.

### Docker

```sh
docker build -t us-drought-monitor-mcp-server .
docker run --rm -p 127.0.0.1:3010:3010 us-drought-monitor-mcp-server
```

The image defaults to HTTP on port 3010 with native DuckDB enabled.

## Project structure

| Path | Purpose |
|:---|:---|
| `src/index.ts` | Identity, tool registration, analytical defaults and setup |
| `src/config/canvas-config.ts` | Canvas configuration and opt-in drop |
| `src/mcp-server/tools/definitions/` | Eight tool definitions |
| `src/services/drought/` | USDM client, geography references, date logic, workflows, staging and rendering |
| `src/services/canvas-accessor.ts` | Configured DataCanvas access |
| `tests/` | Offline unit, contract and integration tests |
| `scripts/` | Build, lint, bundle, release and documentation tooling |

## Development guide

See [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md). Register tools in `src/index.ts`, keep service error reasons aligned with inline tool contracts, and preserve missing observations and full output parity.

## Contributing

Run local verification before submitting changes:

```sh
bun run devcheck
bun run test
```

## License

[Apache-2.0](./LICENSE).

The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.

DSCI: Akyuz, F. A. 2017. *Drought Severity and Coverage Index*. United States Drought Monitor.
