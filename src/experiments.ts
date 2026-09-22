import { closeDuckDB, getDuckDBConnection } from './db'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface TimedResult<T> {
  durationMs: number
  result: T
}

export interface OPFSEntry {
  path: string
  kind: 'directory' | 'file'
  sizeBytes?: number
  lastModified?: string
}

interface DirectoryHandleLike {
  entries(): AsyncIterableIterator<[string, FileHandleLike | DirectoryHandleLike]>
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  kind: 'directory'
}

interface FileHandleLike {
  getFile(): Promise<File>
  kind: 'file'
}

const CACHE_DIRECTORY = 'cache'
const CACHE_FILE = 'monthly_totals.parquet'

async function timed<T>(operation: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now()
  const result = await operation()
  return { durationMs: performance.now() - start, result }
}

function normalize(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return value === undefined ? 'undefined' : null
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map(normalize)
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer)).map(normalize)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalize(nestedValue)]),
    )
  }
  return String(value)
}

function rowsToJson(table: {
  toArray(): Array<{ toJSON(): unknown }>
}): JsonValue[] {
  return table.toArray().map((row) => normalize(row.toJSON()))
}

function opfsRoot(): Promise<DirectoryHandleLike> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('Origin Private File System is unavailable in this browser.')
  }
  return navigator.storage.getDirectory() as unknown as Promise<DirectoryHandleLike>
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

async function cacheExists(): Promise<boolean> {
  try {
    const root = await opfsRoot()
    const cache = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: false })
    await cache.getFileHandle(CACHE_FILE, { create: false })
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

export function createPersistenceTestTable(): Promise<TimedResult<{ created: true }>> {
  return timed(async () => {
    await getDuckDBConnection().query(`
      CREATE TABLE IF NOT EXISTS repro_events (
        id BIGINT,
        created_at TIMESTAMP
      );
    `)
    return { created: true }
  })
}

export function insertPersistenceRow(): Promise<TimedResult<JsonValue[]>> {
  return timed(async () => {
    const connection = getDuckDBConnection()
    await connection.query(`
      INSERT INTO repro_events
      SELECT coalesce(max(id), 0) + 1, current_timestamp
      FROM repro_events;
    `)
    await connection.query('CHECKPOINT;')
    const inserted = await connection.query(`
      SELECT id, created_at
      FROM repro_events
      ORDER BY id DESC
      LIMIT 1;
    `)
    return rowsToJson(inserted)
  })
}

export function readPersistenceState(): Promise<TimedResult<JsonValue[]>> {
  return timed(async () => {
    const result = await getDuckDBConnection().query(`
      SELECT
        count(*) AS row_count,
        max(id) AS latest_id,
        min(created_at) AS first_created_at,
        max(created_at) AS latest_created_at
      FROM repro_events;
    `)
    return rowsToJson(result)
  })
}

export function importRemoteOrders(): Promise<
  TimedResult<{ tableAlreadyExisted: boolean }>
> {
  return timed(async () => {
    const connection = getDuckDBConnection()
    const before = await connection.query(`
      SELECT count(*)::INTEGER AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'main' AND table_name = 'orders';
    `)
    const row = before.toArray()[0]?.toJSON() as { table_count?: number } | undefined

    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders AS
      SELECT *
      FROM 'https://shell.duckdb.org/data/tpch/0_01/parquet/orders.parquet';
    `)
    await connection.query('CHECKPOINT;')
    return { tableAlreadyExisted: row?.table_count === 1 }
  })
}

export function readOrdersSummary(): Promise<TimedResult<JsonValue[]>> {
  return timed(async () => {
    const result = await getDuckDBConnection().query(`
      SELECT
        count(*) AS row_count,
        min(o_orderdate) AS first_order_date,
        max(o_orderdate) AS last_order_date,
        sum(o_totalprice)::VARCHAR AS total_price
      FROM orders;
    `)
    return rowsToJson(result)
  })
}

export function writeMonthlyAggregation(): Promise<
  TimedResult<{ cachePath: string }>
> {
  return timed(async () => {
    await getDuckDBConnection().query(`
      COPY (
        SELECT
          o_orderpriority AS priority,
          date_trunc('month', o_orderdate) AS month,
          sum(o_totalprice) AS total
        FROM orders
        GROUP BY ALL
      ) TO 'opfs://cache/monthly_totals.parquet'
      (FORMAT PARQUET);
    `)
    return { cachePath: 'opfs://cache/monthly_totals.parquet' }
  })
}

export function readCachedAggregation(): Promise<TimedResult<JsonValue[]>> {
  return timed(async () => {
    if (!(await cacheExists())) {
      throw new Error(
        'The OPFS aggregation cache does not exist. Generate it before attempting to read it.',
      )
    }
    const result = await getDuckDBConnection().query(`
      SELECT
        priority,
        month,
        total::VARCHAR AS total
      FROM 'opfs://cache/monthly_totals.parquet'
      ORDER BY priority, month;
    `)
    return rowsToJson(result)
  })
}

export function compareCachedAggregation(): Promise<
  TimedResult<{
    freshMinusCached: JsonValue[]
    cachedMinusFresh: JsonValue[]
    matches: boolean
  }>
> {
  return timed(async () => {
    if (!(await cacheExists())) {
      throw new Error(
        'The OPFS aggregation cache does not exist. Generate it before comparing it.',
      )
    }

    const connection = getDuckDBConnection()
    const freshMinusCached = await connection.query(`
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
      SELECT * FROM fresh
      EXCEPT ALL
      SELECT * FROM cached;
    `)
    const cachedMinusFresh = await connection.query(`
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
      SELECT * FROM cached
      EXCEPT ALL
      SELECT * FROM fresh;
    `)

    const forwardRows = rowsToJson(freshMinusCached)
    const reverseRows = rowsToJson(cachedMinusFresh)
    return {
      freshMinusCached: forwardRows,
      cachedMinusFresh: reverseRows,
      matches: forwardRows.length === 0 && reverseRows.length === 0,
    }
  })
}

async function listDirectory(
  directory: DirectoryHandleLike,
  prefix: string,
): Promise<OPFSEntry[]> {
  const entries: OPFSEntry[] = []
  for await (const [name, handle] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      entries.push({ path: `${path}/`, kind: 'directory' })
      entries.push(...(await listDirectory(handle, path)))
    } else {
      const file = await handle.getFile()
      entries.push({
        path,
        kind: 'file',
        sizeBytes: file.size,
        lastModified: new Date(file.lastModified).toISOString(),
      })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

export function listRelevantOPFSFiles(): Promise<TimedResult<OPFSEntry[]>> {
  return timed(async () => {
    const entries = await listDirectory(await opfsRoot(), '')
    return entries.filter(
      ({ path }) =>
        /^analytics\.duckdb(?:\.|\/|$)/.test(path) ||
        path === `${CACHE_DIRECTORY}/` ||
        path === `${CACHE_DIRECTORY}/${CACHE_FILE}`,
    )
  })
}

export function resetDemoStorage(): Promise<
  TimedResult<{ removed: string[]; retained: string[] }>
> {
  return timed(async () => {
    await closeDuckDB()
    const root = await opfsRoot()
    const removed: string[] = []
    const retained: string[] = []

    for await (const [name] of root.entries()) {
      if (/^analytics\.duckdb(?:\.|$)/.test(name)) {
        await root.removeEntry(name, { recursive: true })
        removed.push(name)
      }
    }

    try {
      const cache = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: false })
      try {
        await cache.removeEntry(CACHE_FILE)
        removed.push(`${CACHE_DIRECTORY}/${CACHE_FILE}`)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }

      try {
        await root.removeEntry(CACHE_DIRECTORY)
        removed.push(`${CACHE_DIRECTORY}/`)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidModificationError') {
          retained.push(`${CACHE_DIRECTORY}/ (contains unrelated entries)`)
        } else if (!isNotFound(error)) {
          throw error
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }

    return { removed, retained }
  })
}
