# NFCorpus FTS in DuckDB-Wasm: observed results

This is the first browser proof of concept. Values below are from the application operation log unless marked otherwise. `NOT TESTED` means the step has not been observed.

## Environment and data

- Browser: Chrome 153 on macOS.
- Origin: `http://127.0.0.1:5175`; OPFS database: `opfs://analytics.duckdb`.
- npm package: `@duckdb/duckdb-wasm` 1.32.0; DuckDB SQL engine: v1.4.3.
- Selected bundle/platform: `eh` / `wasm_eh`.
- Source: [BEIR NFCorpus](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip), `corpus.jsonl` plus `queries.jsonl`.
- Prepared file: `public/nfcorpus.jsonl`, 3,633 rows with `id` and raw title-plus-text `contents`. The browser fetches this same-origin file, registers it through `AsyncDuckDB.registerFileBuffer`, and imports it with `read_json_auto(..., format = 'newline_delimited')` into a persistent `nfcorpus` table.
- Input SHA-256: corpus `10cc83ef1826b1425e6a87090b5140b39b27755d5a27e48215a88611c899991f`; queries `d024e6621b84925d485ae473d316a0c3af31c62c8068a59fb29d22f7613aef2a`.
- Prepared JSONL SHA-256: `1c9b34e5e5d80bbdfe49cc16e1d96703fbc711ca347d55dd6338a11c61a804e9`.

## Extension, index, and query

`INSTALL fts; LOAD fts;` succeeded in the browser worker. `duckdb_extensions()` reported `loaded = true`, `installed = false` on platform `wasm_eh`. The disposable FTS smoke table was indexed and returned a non-null `match_bm25` score for `aneurysm`. The first smoke action took **3,262.7 ms**. The extension is loaded per session; the persistent database does not eliminate the need to load it on a later session. In a fresh-worker DevTools Network trace with cache disabled, `https://extensions.duckdb.org/v1.4.3/wasm_eh/fts.duckdb_extension.wasm` returned **200 OK** (121 kB transferred, 480 kB decoded); the repeat smoke action passed in **598.8 ms**.

The corpus import took **5,812.6 ms** and reported **3,633 documents**. Index creation took **6,098.3 ms** and used:

```sql
PRAGMA create_fts_index(
  'nfcorpus', 'id', 'contents', stemmer = 'porter',
  stopwords = 'english', strip_accents = 1, lower = 1, overwrite = 0
);
```

DuckDB's documented default `ignore = '(\.|[^a-z])+'` is not overridden. The FTS extension creates `fts_main_nfcorpus`. The initial query was NFCorpus `PLAIN-3074`, **“How to Help Prevent Abdominal Aortic Aneurysms”**, and took **299.2 ms**:

```sql
SELECT id, score
FROM (
  SELECT id,
    fts_main_nfcorpus.match_bm25(
      id, ?, k := 0.9, b := 0.4, conjunctive := 0
    ) AS score
  FROM nfcorpus
)
WHERE score IS NOT NULL
ORDER BY score DESC, id ASC
LIMIT 10;
```

The `?` is bound to the query text. The null filter excludes unmatched documents while retaining a possible zero score.

| Rank | Document ID | BM25 score |
| ---: | --- | ---: |
| 1 | MED-4555 | 9.77640792426441 |
| 2 | MED-4423 | 6.8349302135685175 |
| 3 | MED-3180 | 5.923642405931718 |
| 4 | MED-1009 | 4.892904554603193 |
| 5 | MED-4424 | 4.61924963141959 |
| 6 | MED-720 | 4.4868236984330885 |
| 7 | MED-2229 | 4.448330838884276 |
| 8 | MED-4902 | 4.357123783781641 |
| 9 | MED-1512 | 4.2549994531008695 |
| 10 | MED-3254 | 4.1136909017559065 |

Additional browser searches: `breast cancer statins` ranked `MED-10` first; an unmatched term returned an empty list; a query containing an apostrophe (`women's health`) succeeded through the prepared statement.

## Persistence and browser-only evidence

- A development HMR reload, followed by reopening DuckDB-Wasm at the same origin, retained **3,633 documents**, the FTS schema, and the exact initial Top-10 IDs and scores without reimporting or rebuilding.
- Explicit **Close DuckDB** followed by a reload at the same origin: **PASS**. Close completed in `37.7 ms` after `CHECKPOINT`, connection close, and worker termination. A fresh worker reopened the database; inspection found `3,633` documents, `3,633` distinct IDs, and the FTS index. Search succeeded before any import or index rebuild, with the exact same Top-10 IDs and scores. That first reopened search took `2,998.3 ms`, including extension verification/loading.
- Full browser-process quit and restart in the same profile: **NOT TESTED**.
- Browser-only Network verification: **PASS**. In Chrome DevTools Network with recording and **Disable cache** enabled, the log was cleared before each search. The representative query completed in `234.4 ms` and changed query `breast cancer statins` in `43.2 ms`; neither produced any network requests. A Request conditions rule then blocked `*://127.0.0.1:5175/nfcorpus.jsonl`. With the log cleared, `women's health` still returned hits in `115.1 ms` and produced no network requests; the rule showed zero affected requests. This establishes that these search computations used the browser's existing DuckDB-Wasm state without fetching the corpus or a server search result. The prior Request conditions settings were restored afterward.
- Native DuckDB v1.4.3 comparison: **PASS**. An isolated native run used the same prepared JSONL, index options, and query. All ten ranked IDs and scores matched the browser run exactly (maximum absolute score difference `0`). Native timing: import `0.418 s`, index `0.524 s`, search `0.0133 s`. These timings are from different execution environments and are not a controlled performance comparison. QuackIR's older DuckDB and Pyserini/Lucene preprocessing remain a separate retrieval pipeline.

FTS creates persistent index objects, but loading its extension is session-specific. The original contents are left un-tokenized; DuckDB's Porter stemming, English stopwords, accent stripping, lowercasing, and default ignore expression define this experiment's analysis. This is a functional proof of concept, not a full NFCorpus benchmark or a ranking parity claim.
