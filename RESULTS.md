# Experiment results

This log records observed behavior only. `NOT TESTED` means the corresponding step was
not completed in the stated environment.

## Environment

| Field | Observed value |
| --- | --- |
| Date and time | 2026-09-21 (initial run and native-Chrome completion run) |
| OS | macOS 26.5.2 (Build 25F84), arm64 |
| Browser and version | Google Chrome; UA reports Chrome/153.0.0.0 |
| Node version | v25.8.2 |
| pnpm version | 10.33.0 |
| Vite version | 8.3.0 |
| DuckDB-Wasm package | 1.32.0 (exact pin) |
| `SELECT version()` | v1.4.3 |
| Selected Wasm bundle | `eh` |
| Origin | `http://localhost:5174` for the native-Chrome completion run |
| OPFS available | `true` |
| Initial storage state | Clean origin: no `orders` table or demo cache |
| HTTP cache state | Chrome DevTools **Disable cache** enabled while DevTools was open |

Node `v25.8.2` satisfies Vite 8.3.0's declared Node engine range
(`^20.19.0 || >=22.12.0`).

## Static verification

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm list --depth=0` | PASS | DuckDB-Wasm resolved to 1.32.0; TypeScript 6.0.3; Vite 8.3.0 |
| `pnpm exec tsc --noEmit` | PASS | Completed with no diagnostics |
| `pnpm build` | PASS | Vite 8.3.0 built 148 modules successfully |
| Existing lint command | NOT APPLICABLE | The generated project has no lint script |

## Persistence test

| Step | Result | Observation | Duration |
| --- | --- | --- | --- |
| Clean baseline | PASS | Initial relevant OPFS listing was empty, so deletion was unnecessary | 40.6 ms |
| Initial empty table | PASS | `row_count = 0`; IDs and timestamps were null | 35.7 ms |
| Insert first row | PASS | Inserted `id = 1` and checkpointed | 83.4 ms |
| Inspect `row_count = 1` | PASS | Latest ID was `1` | 14.5 ms |
| Reload and inspect `row_count = 1` | PASS | Same ID and timestamp survived the reload | 43.4 ms |
| Insert second row | PASS | Inserted `id = 2` and checkpointed | 117.0 ms |
| Inspect `row_count = 2` | PASS | Latest ID was `2` | 2.6 ms |
| Clean shutdown | PASS | Awaited `CHECKPOINT`, connection close, worker termination | 9.4 ms |
| Close tab, reopen same profile/origin, inspect `row_count = 2` | PASS | Both rows remained | 12.4 ms query |
| Full browser-process restart and inspect `row_count = 2` | PASS | Chrome was fully quit, confirmed absent from the running-app inventory, manually reopened, and both rows remained | query completed after restart |

## Remote orders import

| Step | Result | Observation | Duration |
| --- | --- | --- | --- |
| First materialization | PASS | `tableAlreadyExisted = false` | 1,257.5 ms |
| First orders summary | PASS | Recorded below | 6.1 ms |
| Reload, local summary before repeat import | PASS | Local query succeeded before import was rerun | 13.1 ms |
| Repeat literal `CREATE TABLE IF NOT EXISTS` | PASS (SQL) | `tableAlreadyExisted = true`; it issued one source `HEAD` request but no `GET` | 52.5 ms |
| Summary equality | PASS | Row count, date bounds, and total-price string matched exactly |  |

Actual orders summary (do not assume a row count):

```text
row_count: 15000
first_order_date (Arrow epoch ms): 694224000000
last_order_date (Arrow epoch ms): 902016000000
total_price: 2127396830.0200024
```

### Network evidence

| Phase | Request count | Method/status | Range / Content-Range | Transferred bytes | Cache provenance |
| --- | ---: | --- | --- | ---: | --- |
| First import — source file only | 2 | `HEAD 200`, then `GET 200` | No `Range` request and no `206`; `Accept-Ranges: bytes` was advertised | HEAD: 0-byte body; GET: about 434 kB transferred / 1,151 kB decoded | Network cache disabled |
| First import — extension setup | 1 | `parquet.duckdb_extension.wasm`, `200` | Not applicable | about 668 kB transferred / 3,045 kB decoded | Network cache disabled |
| Local summary after reload | 0 | No `orders.parquet` request | Not applicable | 0 | Network panel cleared immediately before query |
| Repeat import statement | 1 | `HEAD 200`; no `GET` | No range request | 811 B transferred / 0-byte body | Network cache disabled |
| Source-blocked verification | 1 deliberate re-import | `(blocked:devtools)` | Request blocked before response | 0 | DevTools rule `*://shell.duckdb.org/*` |

The request counts above were read directly from Chrome DevTools. No HAR was exported.

## OPFS aggregation cache

| Step | Result | Observation | Duration |
| --- | --- | --- | --- |
| Write monthly aggregation | PASS | Wrote `opfs://cache/monthly_totals.parquet` | 49.3 ms |
| OPFS listing after write | PASS | Cache file was 4,686 bytes | 19.6 ms |
| Reload without regeneration | PASS | Reloaded and initialized without clicking Generate | 637.6 ms initialization |
| Read existing cache | PASS | Read 399 ordered aggregate rows | 138.5 ms |
| Fresh minus cached (`EXCEPT ALL`) | PASS | Zero rows | included below |
| Cached minus fresh (`EXCEPT ALL`) | PASS | Zero rows | included below |
| Exact comparison | PASS | `matches = true` | 118.5 ms |

After the full Chrome process restart, the persistent table still contained two rows,
the local `orders` summary was unchanged, the cached aggregation was readable, and both
`EXCEPT ALL` directions again returned zero rows (`matches = true`).

## Source-server independence

| Check | Result | Observation |
| --- | --- | --- |
| `shell.duckdb.org` request blocking active | PASS | DevTools rule `*://shell.duckdb.org/*` was enabled; the deliberate remote import was shown as `(blocked:devtools)` and the rule reported one affected request |
| Persistent orders table query | PASS under blocking | Returned the same 15,000-row summary with no source request |
| Cached Parquet read | PASS under blocking | Existing `opfs://cache/monthly_totals.parquet` was read successfully |
| Cache comparison | PASS under blocking | Both `EXCEPT ALL` directions were empty; `matches = true` |
| Successful source-server requests during local-only checks | PASS | Zero; the only source request was the deliberately blocked re-import probe |

The deliberate repeat import failed while blocking was active with an XHR network
error. This is expected from the observed behavior: even when `orders` already exists,
the literal `CREATE TABLE IF NOT EXISTS ... read_parquet(URL)` statement performs a
`HEAD` probe. Local table queries and cached-Parquet operations do not depend on that
probe.

## OPFS artifacts

```text
Before reset:
analytics.duckdb — file — 1,060,864 bytes
analytics.duckdb.wal — file — 1,515,291 bytes
cache/ — directory
cache/monthly_totals.parquet — file — 4,686 bytes

Immediately after reset:
(no demo artifacts)

After fresh reinitialization and the guarded missing-cache read:
analytics.duckdb — file — 12,288 bytes
analytics.duckdb.wal — file — 150 bytes
(no cache directory or Parquet file)
```

## Safe reset verification

| Check | Result | Observation |
| --- | --- | --- |
| Explicit confirmation required | PASS | Native confirmation named the exact database and cache targets |
| Demo artifacts removed | PASS | Removed `analytics.duckdb`, `.wal`, cache Parquet, and empty cache directory; subsequent listing was empty |
| Unrelated OPFS entries preserved | PASS by scope | No unrelated entries existed for an empirical sentinel test; reset used only the documented allowlist and non-recursive cache-directory removal |
| Fresh initialization is empty | PASS | `repro_events.row_count = 0`; `orders` absent; guarded cache read reported missing without creating a cache file |

## Errors and unexpected behavior

No unexpected application errors were observed during the completed static,
persistence, import, cache-write, reload, cache-read, comparison, listing, reset,
process-restart, source-blocking, or clean-close operations. After reset, the expected
`orders`-missing and cache-missing errors were observed and recorded; the latter
occurred before DuckDB SQL execution and did not create an empty cache artifact. The
blocked deliberate re-import produced the expected XHR network error.

An earlier attempt to reuse the previously exercised `localhost:5173` profile state
reported `TransactionContext Error: Failed to commit: File is not opened in write
mode`. The native-Chrome completion run therefore used the clean, same-profile origin
`localhost:5174`; all persistence and full-process-restart checks passed there. This
was treated as stale test-state contamination rather than an application failure.

The Vite development server emitted non-fatal warnings that DuckDB-Wasm's bundled
worker source map refers to Apache Arrow source files outside the npm package. These
warnings did not affect TypeScript checking, the production build, or browser behavior.

## Deviations from the official example

- The repository root was already a Vite `vanilla-ts` scaffold, so the project was
  completed in place instead of creating a redundant nested `duckdb-opfs-repro/`
  directory.
- Worker and Wasm assets are Vite-bundled with `?url` imports instead of loaded from a
  CDN.
- The UI checks that the cache exists through the browser OPFS API before a cache read
  or comparison. This avoids creating an empty artifact on a failed read under the
  package's automatic OPFS handling.

## Final summary

**PASS** — static checks, reload and full-browser-process persistence, remote
materialization, exact request inspection, cached-Parquet reload, exact cache
comparison, source-host blocking, and safe reset all passed. The one important nuance
is that repeating the literal remote import still performs a source `HEAD` probe even
when the table already exists; local queries and OPFS cache reads remain fully
source-independent.
