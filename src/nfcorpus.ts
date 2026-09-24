import { getDuckDB, getDuckDBConnection } from './db'

const CORPUS_URL = '/nfcorpus.jsonl'
const CORPUS_FILE = 'nfcorpus-import.jsonl'
const EXPECTED_DOCUMENTS = 3633
const EXAMPLE_QUERY = 'How to Help Prevent Abdominal Aortic Aneurysms'

export interface SearchHit {
  id: string
  score: number
}

let verifiedWorker: ReturnType<typeof getDuckDB> | null = null

function rowObjects(table: { toArray(): Array<{ toJSON(): unknown }> }): Record<string, unknown>[] {
  return table.toArray().map((row) => row.toJSON() as Record<string, unknown>)
}

async function hasCorpus(): Promise<boolean> {
  const rows = rowObjects(await getDuckDBConnection().query(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'nfcorpus'",
  ))
  return Number(rows[0]?.n) > 0
}

async function hasIndex(): Promise<boolean> {
  const rows = rowObjects(await getDuckDBConnection().query(
    "SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'fts_main_nfcorpus'",
  ))
  return Number(rows[0]?.n) > 0
}

export async function verifyFTS(): Promise<Record<string, unknown>> {
  const db = getDuckDB()
  const conn = getDuckDBConnection()
  if (verifiedWorker === db) {
    return { alreadyVerified: true, worker: true }
  }

  const started = performance.now()
  try {
    await conn.query('INSTALL fts;')
    await conn.query('LOAD fts;')
    const platform = rowObjects(await conn.query('PRAGMA platform;'))
    const extension = rowObjects(await conn.query(
      "SELECT extension_name, loaded, installed, install_mode, installed_from FROM duckdb_extensions() WHERE extension_name = 'fts'",
    ))
    if (extension.length !== 1 || extension[0].loaded !== true) {
      throw new Error('FTS extension did not report loaded=true.')
    }

    // This exercises extension loading, indexing, and its retrieval macro in the
    // actual browser worker before the full corpus is fetched.
    await conn.query('DROP TABLE IF EXISTS nfcorpus_fts_probe;')
    await conn.query('CREATE TABLE nfcorpus_fts_probe (id VARCHAR, contents VARCHAR);')
    try {
      await conn.query("INSERT INTO nfcorpus_fts_probe VALUES ('probe', 'vascular aneurysm prevention');")
      await conn.query("PRAGMA create_fts_index('nfcorpus_fts_probe', 'id', 'contents');")
      const matches = rowObjects(await conn.query(
        "SELECT fts_main_nfcorpus_fts_probe.match_bm25(id, 'aneurysm') AS score FROM nfcorpus_fts_probe",
      ))
      if (matches.length !== 1 || matches[0].score === null) {
        throw new Error('FTS probe did not return a non-null match.')
      }
    } finally {
      await conn.query("PRAGMA drop_fts_index('nfcorpus_fts_probe');")
      await conn.query('DROP TABLE nfcorpus_fts_probe;')
    }
    verifiedWorker = db
    await conn.query('CHECKPOINT;')
    return {
      loaded: true,
      platform,
      extension,
      smokeTest: 'passed',
      durationMs: performance.now() - started,
      worker: true,
    }
  } catch (error) {
    const requests = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('fts.duckdb_extension'))
      .map((entry) => entry.name)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`DuckDB-Wasm FTS verification failed: ${message}. Extension requests: ${JSON.stringify(requests)}`)
  }
}

export async function inspectNFCorpus(): Promise<Record<string, unknown>> {
  const conn = getDuckDBConnection()
  const corpusExists = await hasCorpus()
  const indexExists = await hasIndex()
  const statistics = corpusExists
    ? rowObjects(await conn.query(
      'SELECT count(*) AS documents, count(DISTINCT id) AS unique_ids FROM nfcorpus',
    ))[0]
    : null
  return { corpusExists, indexExists, statistics, worker: true }
}

export async function loadNFCorpus(): Promise<Record<string, unknown>> {
  if (await hasCorpus()) return { alreadyLoaded: true, ...(await inspectNFCorpus()) }
  await verifyFTS()
  const response = await fetch(CORPUS_URL)
  if (!response.ok) throw new Error(`NFCorpus asset request failed: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const sourceBytes = bytes.byteLength
  const db = getDuckDB()
  const conn = getDuckDBConnection()
  await db.registerFileBuffer(CORPUS_FILE, bytes)
  try {
    await conn.query('BEGIN TRANSACTION;')
    try {
      await conn.query('CREATE TABLE nfcorpus (id VARCHAR PRIMARY KEY, contents VARCHAR NOT NULL);')
      await conn.query(`
        INSERT INTO nfcorpus (id, contents)
        SELECT id, contents FROM read_json_auto('${CORPUS_FILE}', format = 'newline_delimited');
      `)
      const rows = rowObjects(await conn.query(
        "SELECT count(*) AS documents, count(DISTINCT id) AS unique_ids, count(*) FILTER (WHERE id = '' OR contents = '') AS empty_fields FROM nfcorpus",
      ))
      const counts = rows[0]
      if (Number(counts.documents) !== EXPECTED_DOCUMENTS ||
          Number(counts.unique_ids) !== EXPECTED_DOCUMENTS ||
          Number(counts.empty_fields) !== 0) {
        throw new Error(`NFCorpus validation failed: ${JSON.stringify(counts)}`)
      }
      await conn.query('COMMIT;')
    } catch (error) {
      await conn.query('ROLLBACK;')
      throw error
    }
    await conn.query('CHECKPOINT;')
    return { imported: true, sourceBytes, ...(await inspectNFCorpus()) }
  } finally {
    await db.dropFile(CORPUS_FILE)
  }
}

export async function buildNFCorpusIndex(): Promise<Record<string, unknown>> {
  if (!(await hasCorpus())) throw new Error('Load NFCorpus before creating its FTS index.')
  await verifyFTS()
  if (await hasIndex()) return { alreadyIndexed: true, ...(await inspectNFCorpus()) }
  const conn = getDuckDBConnection()
  const started = performance.now()
  await conn.query(`
    PRAGMA create_fts_index(
      'nfcorpus', 'id', 'contents', stemmer = 'porter',
      stopwords = 'english', strip_accents = 1, lower = 1, overwrite = 0
    );
  `)
  await conn.query('CHECKPOINT;')
  return { indexed: true, durationMs: performance.now() - started, ...(await inspectNFCorpus()) }
}

export async function searchNFCorpus(queryText: string): Promise<{ query: string; hits: SearchHit[]; worker: true }> {
  const query = queryText.trim()
  if (!query) throw new Error('Enter a nonempty search query.')
  if (!(await hasCorpus())) throw new Error('Load NFCorpus before searching.')
  if (!(await hasIndex())) throw new Error('Build the NFCorpus FTS index before searching.')
  await verifyFTS()
  const conn = getDuckDBConnection()
  const statement = await conn.prepare(`
    SELECT id, score
    FROM (
      SELECT id, fts_main_nfcorpus.match_bm25(
        id, ?, k := 0.9, b := 0.4, conjunctive := 0
      ) AS score FROM nfcorpus
    )
    WHERE score IS NOT NULL
    ORDER BY score DESC, id ASC
    LIMIT 10;
  `)
  try {
    const hits = rowObjects(await statement.query(query)).map((row) => ({
      id: String(row.id),
      score: Number(row.score),
    }))
    return { query, hits, worker: true }
  } finally {
    await statement.close()
  }
}

export { EXAMPLE_QUERY }
