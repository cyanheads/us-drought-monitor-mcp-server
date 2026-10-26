---
name: us-drought-monitor-guide
description: Use drought_* tools to assess published U.S. Drought Monitor severity, compare areas or periods, and investigate county drought duration. Resolve geography, check coverage and interpretation, then complete staged SQL rows and retained metadata before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this keyless server for published weekly USDM observations and drought statistics. It does not predict future drought, locate a coordinate within a boundary, or determine disaster-program eligibility. A River Forecast Center selector identifies an observation boundary; it does not request a forecast.

## Identifiers

Resolve the requested boundary with `drought_list_reference` before acquiring observations. Use its canonical identifier as a string, preserving leading zeroes. Do not derive a climate-division identifier from state FIPS or substitute a nearby administrative boundary for a watershed or operational region. Resolve a county within its state; a shared county name is insufficient.

For nested watersheds, discover the parent HUC, then its descendants at the required level. Keep that level consistent throughout a history request. The reference bundle identifies supported boundaries; its vintage is not the latest observation date.

When `drought_get_timeseries` or `drought_compare_areas` stages a result, use its returned canvas token and table name. Discover additional table names and SQL columns with `drought_dataframe_describe`; never construct names from geography labels.

## Gates

1. **Establish coverage before interpreting absence.** Check the effective map dates, coverage guidance and missing-component statuses. An empty result or null value does not establish zero drought. For legacy Connecticut counties, follow the returned planning-region guidance and resolve the intended boundary; do not translate county boundaries into planning regions.
2. **Keep national boundaries separate.** If a selector resolves to CONUS and Total, choose the boundary answering the question and label it. Do not add or average those overlapping results.
3. **Match the measure to the conclusion.** Use a cumulative bucket for “category or worse” and exclusive buckets for a category distribution. Do not sum overlapping cumulative buckets as a population or area total. Retain units when comparing results: a difference between coverage percentages is expressed in percentage points; a DSCI change is an index difference.
4. **Qualify population figures.** Carry the returned methodology caveat into conclusions: population figures are rough census-based estimates assuming uniform population within counties, not exact contemporary headcounts. Preserve source values without inferring a census vintage. Unsupported population and missing supported observations remain distinct.
5. **Establish completeness separately from interpretation.** Before claiming “all,” “none,” or an exhaustive ranking, finish the relevant result and metadata continuation. A preview, partial collection or missing comparison side cannot support that claim.

## Core chain

Resolve the user's boundary with `drought_list_reference`, acquire the appropriate observation workflow, inspect the effective dates and availability, then continue retained results as needed. Keep provenance and interpretation with the answer, including after SQL aggregation.

## Workflows

### Current conditions or a dated snapshot

Use `drought_get_current_severity` after resolving the area. Report the actual returned map date rather than treating the request date or retrieval date as the observation date. Interpret the exact four-week and fifty-two-week baseline statuses before describing a change; do not replace a missing baseline with a nearby observation.

### History across areas

Use `drought_get_timeseries` for explicit areas sharing a geography type and, for watersheds, a HUC level. Inspect the effective range and missing metric and DSCI observations before comparing peaks or trends. Summaries cover the full acquired series; tied peak dates are not separate drought events. Expand returned date runs only when the task needs individual weeks.

### Severity rankings or worsening

Use `drought_compare_areas` for state or county rankings. A severity ranking answers “worst at the target date”; a baseline comparison answers “largest change.” Select the latter for worsening or improvement, and check the returned baseline date, change unit and excluded areas. Preserve equal ranks rather than breaking ties by the preview order. When a ranking is staged, use its complete table for analysis beyond the preview.

### County duration

Use `drought_get_weeks_in_drought` for consecutive streaks or total qualifying weeks within a period. Choose the mode matching the question; non-consecutive counts do not establish a continuous streak. Qualification means some county area meets the threshold, not that the entire county does. When boundary flags indicate possible continuation, describe the streak as bounded by the observed window rather than asserting its true start or end. Duration alone does not establish program eligibility.

### Complete rows and analytical SQL

With an analytical provider enabled, large results are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `drought_dataframe_describe` with it for the staged table and column names before writing SQL, then `drought_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first. Check each table's returned expiry; a canvas token does not guarantee that every table still exists.

With the provider disabled and no canvas token supplied, producers return complete inline results within acquisition limits. A null staging handle does not mean rows were discarded or require a smaller request. An explicit canvas token still requires successful token access; do not remove it merely to hide an access error.

For every original row, query the described table with `SELECT *` and `ORDER BY row_id`. Keep SQL unchanged while following each returned `next_offset` until null. For a transformed query, choose an ordering that remains stable across pages. Do not add a SQL row limit when the task requires the whole result. Use `COUNT(*)` for an exact count of a filtered or joined result rather than counting one response page.

Before joining tables, inspect their geography, dates, metric, units and representation. Join on the canonical identity and map date appropriate to the question; do not join on a display name or assume two tables contain the same coverage. SQL cannot restore missing source observations.

### Complete retained metadata

Row pagination does not complete metadata. If a time-series response carries `metadata_pages`, inspect each collection's continuation and use `drought_dataframe_describe` to retrieve its remaining retained items. Keep the same canvas, table and collection, following returned offsets until null. This completes missing-observation details, resolved areas and summaries without acquiring a different upstream snapshot.

Only after both row and relevant metadata retrieval are complete should an answer claim exhaustive coverage. Retain missingness and provenance alongside any exported or summarized result.

### Expiry and installation limits

If a table or token has expired, rerun its producer and inspect the new result before continuing; old offsets do not identify the new result. If analytical query or describe reports an unavailable provider, follow the error's installation guidance when SQL analysis is needed. Do not report an acquisition or analytical failure as an empty dataset. Remove a staged table only when removal is enabled and the requested task calls for deleting that analytical copy.
