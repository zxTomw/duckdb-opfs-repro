
# Plan: Reproduce DuckDB-Wasm Browser Persistence with Vite and OPFS

## Objective

Build and verify a minimal Vite + TypeScript application that reproduces the behavior described in DuckDB’s “Persistent Databases in the Browser with DuckDB-Wasm and OPFS” blog post.

The reproduction must demonstrate:

1. A DuckDB database persists across page reloads and browser restarts using OPFS.
2. A remote Parquet file is materialized into a persistent local DuckDB table, with
   network behavior recorded for both the first and repeated import statements.
3. Subsequent local-table queries work without fetching the source Parquet file again.
4. An aggregation can be written to an OPFS Parquet file.
5. The cached Parquet file survives reloads and produces the same result as recomputing the aggregation from the local table.

Reference:

- https://duckdb.org/2026/09/18/opfs-wasm
- https://duckdb.org/docs/current/clients/wasm/instantiation

## Important constraints

- Use `pnpm` exclusively. Do not use npm, Yarn, or Bun.
- Use Vite with the `vanilla-ts` template.
- Pin `@duckdb/duckdb-wasm` to exactly `1.32.0`.
- Preserve `pnpm-lock.yaml`.
- Use `opfs://analytics.duckdb` as the database path.
- Use `opfs: { fileHandling: 'auto' }`.
- Run the app consistently at `http://localhost:5174`, matching the published results.
- Do not add React or another UI framework.
- Do not add backend or server-side database code.
- Do not assume an expected row count for the source dataset. Record the actual result.
- Keep the implementation minimal and focused on reproducibility.
- Do not silently change dependency versions if something fails. Record the failure first.
- Do not stop after writing code: run build/type checks and perform every browser verification that the environment supports.
- Do not commit or push unless explicitly requested.

## Phase 1: Inspect the environment

Run:

```bash
node --version
pnpm --version
git status --short
```

Requirements:

- Node.js must satisfy the installed Vite version.
- Record the Node and pnpm versions in `RESULTS.md`.
- If the working directory contains unrelated user changes, preserve them.
- If no repository exists yet, create the project in a new `duckdb-opfs-repro` directory.

## Phase 2: Scaffold the project

Run:

```bash
pnpm create vite duckdb-opfs-repro --template vanilla-ts
cd duckdb-opfs-repro
pnpm install
pnpm add --save-exact @duckdb/duckdb-wasm@1.32.0
pnpm list --depth=0
```

Confirm that `package.json` contains an exact version rather than a caret range:

```json
"@duckdb/duckdb-wasm": "1.32.0"
```

Do not delete `pnpm-lock.yaml`.

## Phase 3: Create the application structure

Use this structure:

```text
duckdb-opfs-repro/
├── index.html
├── package.json
├── pnpm-lock.yaml
├── README.md
├── RESULTS.md
└── src/
    ├── db.ts
    ├── experiments.ts
    ├── main.ts
    └── style.css
```

Responsibilities:

### `src/db.ts`

Implement:

- DuckDB-Wasm bundle selection
- Web Worker creation
- Wasm instantiation
- Opening `opfs://analytics.duckdb`
- Creating one database connection
- Clean shutdown
- Protection against initializing more than once

Use Vite’s `?url` imports for the `mvp` and `eh` bundles:

```ts
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
```

Construct manual bundles and call `duckdb.selectBundle()`.

Open the database with:

```ts
await db.open({
  path: 'opfs://analytics.duckdb',
  accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  opfs: {
    fileHandling: 'auto',
  },
});
```

Expose enough information to display and record:

- Installed npm package version
- Result of `SELECT version()`
- Selected bundle: `mvp` or `eh`
- Database path
- Whether OPFS is available

Clean shutdown must run:

```sql
CHECKPOINT;
```

Then:

```ts
await conn.close();
await db.terminate();
```

### `src/experiments.ts`

Implement separate functions for:

1. Creating the persistence test table
2. Inserting one test row
3. Reading the persistence state
4. Importing the remote `orders` Parquet file
5. Reading an `orders` summary
6. Writing the monthly aggregation to OPFS Parquet
7. Reading the cached aggregation
8. Comparing the cached aggregation with a fresh aggregation
9. Listing relevant OPFS files, if possible
10. Resetting only this demo’s OPFS artifacts

Measure every major operation with `performance.now()`.

Do not automatically insert rows, import data, or overwrite the cached Parquet file during page initialization.

### `src/main.ts`

Build a small interface with these actions:

- Initialize DuckDB
- Insert persistence row
- Inspect persistence state
- Import remote orders
- Inspect orders summary
- Generate OPFS aggregation cache
- Read cached aggregation
- Compare cache with source table
- Check OPFS files
- Close DuckDB
- Reset demo storage

The UI must display:

- Current state
- Query results
- Duration of each operation
- Errors with stack traces where available
- Environment and DuckDB version information

Disable incompatible buttons while an operation is running.

### `README.md`

Document:

- Project purpose
- Environment requirements
- Installation and start commands
- Exact manual reproduction sequence
- How to inspect Network requests
- How to inspect OPFS in browser DevTools
- How to reset the experiment
- Known OPFS limitations
- The difference between the blog’s CDN worker setup and this Vite-bundled setup

### `RESULTS.md`

Create a structured experiment log with placeholders for:

- Date and time
- OS
- Browser and version
- Node version
- pnpm version
- DuckDB-Wasm package version
- `SELECT version()` result
- Selected Wasm bundle
- Origin
- Initial storage state
- HTTP cache state
- Results of each test
- Timing results
- Network evidence
- Screenshots/HAR filenames, if captured
- Errors and unexpected behavior
- Deviations from the official example
- Final pass/fail summary

Do not fabricate results. Mark anything not tested as `NOT TESTED`.

## Phase 4: Implement persistence test

Create the table without inserting anything during initialization:

```sql
CREATE TABLE IF NOT EXISTS repro_events (
    id BIGINT,
    created_at TIMESTAMP
);
```

The explicit insert action should run:

```sql
INSERT INTO repro_events
SELECT coalesce(max(id), 0) + 1, current_timestamp
FROM repro_events;
```

After the write, run:

```sql
CHECKPOINT;
```

Inspect the state using:

```sql
SELECT
    count(*) AS row_count,
    max(id) AS latest_id,
    min(created_at) AS first_created_at,
    max(created_at) AS latest_created_at
FROM repro_events;
```

Verification sequence:

1. Start from clean site storage.
2. Initialize DuckDB.
3. Confirm the table initially has zero rows.
4. Insert one row.
5. Confirm `row_count = 1`.
6. Reload the page.
7. Reinitialize DuckDB.
8. Confirm `row_count = 1`.
9. Insert another row.
10. Confirm `row_count = 2`.
11. Run clean shutdown.
12. Fully close and reopen the browser.
13. Reopen the same origin.
14. Confirm `row_count = 2`.

Record every result in `RESULTS.md`.

## Phase 5: Import and persist the remote Parquet dataset

Use:

```sql
CREATE TABLE IF NOT EXISTS orders AS
SELECT *
FROM 'https://shell.duckdb.org/data/tpch/0_01/parquet/orders.parquet';
```

Then run:

```sql
CHECKPOINT;
```

Inspect the local table using:

```sql
SELECT
    count(*) AS row_count,
    min(o_orderdate) AS first_order_date,
    max(o_orderdate) AS last_order_date,
    sum(o_totalprice)::VARCHAR AS total_price
FROM orders;
```

Browser verification:

1. Open DevTools before importing.
2. Open the Network panel.
3. Enable “Disable cache”.
4. Filter for `orders.parquet` or `shell.duckdb.org`.
5. Run the import for the first time.
6. Record all source Parquet requests, including:
   - request count
   - method
   - status
   - Range header or partial-content behavior
   - transferred bytes
7. Save a screenshot or HAR if possible.
8. Reload the page.
9. Reinitialize the same OPFS database.
10. Run the same `CREATE TABLE IF NOT EXISTS` statement again.
11. Query the table summary.
12. Confirm the summary matches the first run.
13. Confirm whether another source Parquet request occurred.

Expected behavior:

- The first import accesses the remote Parquet file.
- Later executions should find the persistent `orders` table and avoid refetching the source file.

Record actual behavior even if it differs.

## Phase 6: Create and verify the OPFS Parquet cache

Create the cached aggregation:

```sql
COPY (
    SELECT
        o_orderpriority AS priority,
        date_trunc('month', o_orderdate) AS month,
        sum(o_totalprice) AS total
    FROM orders
    GROUP BY ALL
) TO 'opfs://cache/monthly_totals.parquet'
(FORMAT PARQUET);
```

Do not automatically rerun `COPY` after a reload.

Read the cache with:

```sql
SELECT
    priority,
    month,
    total::VARCHAR AS total
FROM 'opfs://cache/monthly_totals.parquet'
ORDER BY priority, month;
```

After writing the file:

1. Record the result and duration.
2. Reload the page.
3. Reinitialize DuckDB.
4. Do not regenerate the cache.
5. Read the existing cached Parquet file.
6. Confirm that it remains readable.

Compare it against a fresh aggregation using SQL. Use `EXCEPT ALL` in both directions:

```sql
WITH fresh AS (
    SELECT
        o_orderpriority AS priority,
        date_trunc('month', o_orderdate) AS month,
        sum(o_totalprice) AS total
    FROM orders
    GROUP BY ALL
),
cached AS (
    SELECT priority, month, total
    FROM 'opfs://cache/monthly_totals.parquet'
)
SELECT *
FROM fresh
EXCEPT ALL
SELECT *
FROM cached;
```

Then run the reverse comparison:

```sql
WITH fresh AS (
    SELECT
        o_orderpriority AS priority,
        date_trunc('month', o_orderdate) AS month,
        sum(o_totalprice) AS total
    FROM orders
    GROUP BY ALL
),
cached AS (
    SELECT priority, month, total
    FROM 'opfs://cache/monthly_totals.parquet'
)
SELECT *
FROM cached
EXCEPT ALL
SELECT *
FROM fresh;
```

Pass condition:

- Both comparisons return zero rows.

Keep decimal comparison inside DuckDB rather than converting values to JavaScript numbers.

## Phase 7: Verify independence from the source server

After the `orders` table and cached Parquet file have been persisted:

1. Block requests to `shell.duckdb.org` in DevTools.
2. Reload the page.
3. Reinitialize the database.
4. Query the `orders` table.
5. Read `opfs://cache/monthly_totals.parquet`.
6. Run the cache comparison again.

Do not use global browser offline mode for the primary test because it may also block application or Wasm assets.

Pass condition:

- The persistent `orders` table remains queryable.
- The cached Parquet remains readable.
- No source-server access is required.

## Phase 8: Inspect OPFS artifacts

Use the browser OPFS API where supported:

```ts
const root = await navigator.storage.getDirectory();
```

Recursively list the files and directories associated with this demo.

Look for artifacts such as:

```text
analytics.duckdb
analytics.duckdb.wal
cache/
  monthly_totals.parquet
```

Additional helper files may appear depending on the DuckDB-Wasm version. Record what actually exists rather than hardcoding it as a test requirement.

Do not leave OPFS handles open unnecessarily.

## Phase 9: Implement safe reset behavior

The reset action must delete only this demo’s artifacts:

- `analytics.duckdb`
- its related WAL/helper files
- `cache/monthly_totals.parquet`
- the empty `cache` directory, if possible

Before deleting:

1. Run `CHECKPOINT`.
2. Close the connection.
3. Terminate DuckDB.
4. Release any registered OPFS file handles.

Do not clear unrelated browser storage automatically.

Require an explicit confirmation in the UI before resetting.

## Phase 10: Static verification

Run:

```bash
pnpm exec tsc --noEmit
pnpm build
```

If linting exists in the generated project, also run its existing lint command. Do not introduce a new linting framework solely for this reproduction.

Fix all type and build errors.

Then start the app with:

```bash
pnpm dev --host localhost --port 5174 --strictPort
```

Use exactly:

```text
http://localhost:5174
```

Do not alternate between `localhost`, `127.0.0.1`, or different ports because OPFS is scoped by origin.

## Phase 11: Acceptance checklist

Mark each item as `PASS`, `FAIL`, or `NOT TESTED` in `RESULTS.md`.

- [ ] Project installs successfully using pnpm.
- [ ] `@duckdb/duckdb-wasm` is pinned to `1.32.0`.
- [ ] Type checking passes.
- [ ] Production build passes.
- [ ] DuckDB-Wasm initializes in the browser.
- [ ] OPFS is available.
- [ ] `SELECT version()` succeeds.
- [ ] Selected Wasm bundle is recorded.
- [ ] A row survives a page reload.
- [ ] Rows survive a full browser restart.
- [ ] The initial Parquet import accesses the remote file.
- [ ] The `orders` table survives reload.
- [ ] Reexecuting `CREATE TABLE IF NOT EXISTS` does not refetch the source file.
- [ ] The first and second `orders` summaries match.
- [ ] The aggregation is written to OPFS Parquet.
- [ ] The cached Parquet survives reload without being regenerated.
- [ ] Both `EXCEPT ALL` comparisons return zero rows.
- [ ] Local queries work while `shell.duckdb.org` is blocked.
- [ ] OPFS artifacts are listed and recorded.
- [ ] Reset deletes only the demo’s files.
- [ ] A complete clean-state rerun succeeds.

## Phase 12: Final report

At completion, report:

1. Files created or changed.
2. Exact commands used.
3. Browser and dependency versions.
4. Which checklist items passed or failed.
5. Actual database and dataset summaries.
6. First-load versus reload timing.
7. First-load versus reload network behavior.
8. OPFS files observed.
9. Any differences from the DuckDB blog.
10. Any bugs, uncertain behavior, or follow-up questions relevant to the Jarminions project.

Do not claim success for browser tests that were not actually performed. Clearly distinguish:

- verified automatically
- verified manually
- not tested
- blocked by the environment
