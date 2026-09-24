# DuckDB-Wasm OPFS persistence reproduction

This is a deliberately small Vite + TypeScript application for reproducing the
workflow in DuckDB's [Persistent Databases in the Browser with DuckDB-Wasm and
OPFS](https://duckdb.org/2026/09/18/opfs-wasm) post.

The app opens `opfs://analytics.duckdb`, materializes the remote TPC-H `orders`
Parquet file as a persistent table, writes a monthly aggregation to
`opfs://cache/monthly_totals.parquet`, and exposes every step as a separate button.
It does not insert rows, import data, or write the cache during page initialization.

## Requirements

- A current browser with OPFS support (Chromium is recommended for DevTools evidence)
- Node.js `^20.19.0` or `>=22.12.0` for the installed Vite version
- pnpm
- One fixed localhost origin for the entire experiment. The published results used
  `http://localhost:5174`.

DuckDB-Wasm is intentionally pinned to `1.32.0`. Do not update it while reproducing
these results without treating that as a separate experiment.

## Install and run

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm build
pnpm dev --host localhost --port 5174 --strictPort
```

Open <http://localhost:5174>. OPFS is scoped to the complete origin, so changing the
host name or port creates a different storage area. Another fixed port is valid for a
fresh run, but it will not expose the OPFS state recorded in `RESULTS.md`.

## Exact manual reproduction

### Persistence table

1. Click **Reset demo storage**, confirm the narrow deletion, and reload.
2. Click **Initialize DuckDB**. Initialization creates only the empty
   `repro_events` table.
3. Click **Inspect persistence state** and record `row_count` (it should be `0` on a
   clean run).
4. Click **Insert persistence row**, then inspect again and record `row_count = 1`.
5. Reload, initialize, and inspect again. Record that the row remains.
6. Insert a second row, inspect `row_count = 2`, then click **Close DuckDB**.
7. Fully quit and reopen the same browser profile, revisit the exact origin,
   initialize, and inspect again. Record whether `row_count = 2`.

Writes explicitly run `CHECKPOINT`. The close action awaits `CHECKPOINT`, connection
close, and worker termination. Browser shutdown hooks are intentionally not used as
a durability guarantee.

### Remote Parquet and persistent local table

1. Open DevTools **before** importing. In Network, enable **Disable cache**, clear the
   log, and filter for `orders.parquet` or `shell.duckdb.org`.
2. Click **Import remote orders** once, then **Inspect orders summary**.
3. Record every source request, including method, status, Range request header,
   Content-Range response, transferred bytes, and cache provenance. A logical import
   can use multiple HTTP requests.
4. Reload and initialize. Clear Network, then click **Inspect orders summary** without
   clicking import. Confirm the summary matches and record whether source requests
   occurred.
5. In a separate cleared trace, click **Import remote orders** again. The button
   deliberately executes the literal `CREATE TABLE IF NOT EXISTS` statement so any
   repeat request behavior is visible rather than hidden by JavaScript.

Keep local-table queries and rerunning the import statement as separate observations.
Record actual behavior even if the second literal statement accesses the source.

### OPFS Parquet cache

1. With `orders` present, click **Generate OPFS aggregation cache** exactly once.
2. Click **Check OPFS files** and record the cache path and size.
3. Reload, initialize, and do **not** regenerate the cache.
4. Click **Read cached aggregation**, then **Compare cache with source table**.
5. The comparison passes only when both `EXCEPT ALL` directions return zero rows and
   `matches` is `true`.

The read and compare actions first check the browser's OPFS directory. This prevents
DuckDB-Wasm 1.32.0 auto file handling from creating a misleading empty file when the
cache does not yet exist.

### Independence from the source server

1. In Chromium DevTools Request Blocking, block `*://shell.duckdb.org/*`.
2. Reload and initialize. Do not use global offline mode, because that would also
   block Vite and Wasm assets.
3. Run **Inspect orders summary**, **Read cached aggregation**, and **Compare cache
   with source table**.
4. Record whether all three work without a successful request to the blocked host.

Requests to DuckDB extension infrastructure, if any, are separate from requests to
the source Parquet host and should be recorded separately.

## Inspecting OPFS

Click **Check OPFS files** for a recursive, read-only listing of this demo's known
artifacts. In Chromium, corroborate it in DevTools under **Application → Storage** or
**Application → Origin private file system** when that view is available. Expected
examples include `analytics.duckdb`, a WAL/helper file, and
`cache/monthly_totals.parquet`; actual helper files vary and are not hard-coded as a
pass condition.

OPFS is origin-private, browser-profile-specific, unavailable in some private modes,
and normally invisible to the host file system. Clearing site data deletes it. Storage
quotas and eviction policies remain browser-controlled.

## Reset

**Reset demo storage** requires explicit confirmation. It first performs the clean
shutdown sequence, then removes only root entries named `analytics.duckdb` or with an
`analytics.duckdb.` helper suffix, plus `cache/monthly_totals.parquet`. It removes the
`cache` directory only when empty, so unrelated cache entries are retained. It never
clears all site data.

## Vite bundle versus the blog's CDN worker

The blog demonstrates loading worker and Wasm assets from a CDN. This project follows
DuckDB's Vite-specific instantiation guidance instead: Vite `?url` imports bundle the
MVP and exception-handling assets locally, `selectBundle()` chooses between them, and
the selected local worker is instantiated directly. The database path, OPFS automatic
file handling, SQL, and persistence behavior are otherwise the same experiment.

Measured outcomes belong in [`RESULTS.md`](./RESULTS.md). Never replace an unperformed
step with an expected value; use `NOT TESTED`.

## NFCorpus search in DuckDB-Wasm

This separate experiment uses the full 3,633-document [BEIR NFCorpus](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip). The checked-in [`public/nfcorpus.jsonl`](./public/nfcorpus.jsonl) contains each document's original ID and its title followed by a space and its text. The preparation step does not tokenize or stem it. To reproduce the file from an extracted BEIR download, run:

```bash
python3 scripts/prepare_nfcorpus.py --source /path/to/nfcorpus
```

Omit `--source` to download the official archive. The script uses only the Python standard library, verifies 3,633 unique nonempty IDs, verifies NFCorpus query `PLAIN-3074`, and prints input and output SHA-256 hashes. It can also accept the ZIP file as `--source`.

Use one fixed origin throughout a persistence test. The run in [`RESULTS-NFCORPUS.md`](./RESULTS-NFCORPUS.md) used `http://127.0.0.1:5175`; for example:

```bash
pnpm install
pnpm build
pnpm dev --host 127.0.0.1 --port 5175 --strictPort
```

Open <http://127.0.0.1:5175>, click **Initialize DuckDB**, **Verify FTS**, **Load corpus**, **Build index**, then **Search**. The prefilled query is `How to Help Prevent Abdominal Aortic Aneurysms` (`PLAIN-3074`). **Inspect NFCorpus state** shows document and distinct-ID counts and whether the generated FTS schema exists. The operation log records durations and results. DuckDB-Wasm uses its browser worker and persists the database at `opfs://analytics.duckdb`. The application fetches the same-origin JSONL once, registers its bytes with DuckDB-Wasm, and bulk-imports it with DuckDB's JSON reader. Search is a prepared DuckDB query; there is no retrieval server endpoint.

The FTS extension is installed and loaded with `INSTALL fts; LOAD fts;` in each browser session. Index creation uses `PRAGMA create_fts_index('nfcorpus', 'id', 'contents', stemmer = 'porter', stopwords = 'english', strip_accents = 1, lower = 1, overwrite = 0)`. DuckDB's documented default `ignore = '(\.|[^a-z])+'` is not overridden. Search uses `fts_main_nfcorpus.match_bm25(id, ?, k := 0.9, b := 0.4, conjunctive := 0)`, orders by descending score and then ID, and returns ten matches. DuckDB handles text analysis inside its FTS extension. This differs from QuackIR's Pyserini/Lucene preprocessing, so exact QuackIR ranking parity is not expected.

To investigate persistence, click **Close DuckDB** (which checkpoints, closes the connection, and terminates the worker), reload at the exact same origin, initialize, inspect, and search before touching **Load corpus** or **Build index**. Then repeat after a full browser quit and restart. To investigate browser-only retrieval, keep DevTools Network open, block `/nfcorpus.jsonl` after the initial import, and try changed queries; record extension asset requests separately. Existing OPFS demo actions share the same database; **Reset demo storage** removes it and therefore removes NFCorpus too. Report measured outcomes in [`RESULTS-NFCORPUS.md`](./RESULTS-NFCORPUS.md).
