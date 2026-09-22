import * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export const DATABASE_PATH = 'opfs://analytics.duckdb'

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
}

export interface DuckDBEnvironment {
  packageVersion: string
  duckdbVersion: string
  selectedBundle: 'mvp' | 'eh'
  databasePath: string
  opfsAvailable: boolean
}

interface DuckDBSession {
  db: duckdb.AsyncDuckDB
  connection: duckdb.AsyncDuckDBConnection
  environment: DuckDBEnvironment
}

let session: DuckDBSession | null = null
let initialization: Promise<DuckDBSession> | null = null

function hasOPFS(): boolean {
  return typeof navigator.storage?.getDirectory === 'function'
}

async function createSession(): Promise<DuckDBSession> {
  if (!hasOPFS()) {
    throw new Error(
      'Origin Private File System is unavailable. Use a supported browser and a secure context such as http://localhost:5173.',
    )
  }

  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES)
  if (!bundle.mainWorker) {
    throw new Error('DuckDB-Wasm selected a bundle without a main worker.')
  }

  const worker = new Worker(bundle.mainWorker)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)

  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    await db.open({
      path: DATABASE_PATH,
      accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      opfs: { fileHandling: 'auto' },
    })

    const connection = await db.connect()
    const versionResult = await connection.query(
      'SELECT version() AS duckdb_version;',
    )
    const versionRow = versionResult.toArray()[0]?.toJSON() as
      | { duckdb_version?: unknown }
      | undefined

    return {
      db,
      connection,
      environment: {
        packageVersion: duckdb.PACKAGE_VERSION,
        duckdbVersion: String(versionRow?.duckdb_version ?? 'UNKNOWN'),
        selectedBundle: bundle.mainModule === ehWasm ? 'eh' : 'mvp',
        databasePath: DATABASE_PATH,
        opfsAvailable: true,
      },
    }
  } catch (error) {
    await db.terminate()
    throw error
  }
}

export async function initializeDuckDB(): Promise<DuckDBEnvironment> {
  if (session) {
    return session.environment
  }

  if (!initialization) {
    initialization = createSession()
      .then((createdSession) => {
        session = createdSession
        return createdSession
      })
      .finally(() => {
        initialization = null
      })
  }

  return (await initialization).environment
}

export function getDuckDBConnection(): duckdb.AsyncDuckDBConnection {
  if (!session) {
    throw new Error('DuckDB is not initialized. Run “Initialize DuckDB” first.')
  }
  return session.connection
}

export function isDuckDBInitialized(): boolean {
  return session !== null
}

export async function closeDuckDB(): Promise<void> {
  if (!session && initialization) {
    try {
      await initialization
    } catch {
      return
    }
  }

  const activeSession = session
  if (!activeSession) {
    return
  }

  session = null
  let firstError: unknown

  try {
    await activeSession.connection.query('CHECKPOINT;')
  } catch (error) {
    firstError = error
  }
  try {
    await activeSession.connection.close()
  } catch (error) {
    firstError ??= error
  }
  try {
    await activeSession.db.terminate()
  } catch (error) {
    firstError ??= error
  }

  if (firstError) {
    throw firstError
  }
}

export const initialEnvironment = {
  packageVersion: duckdb.PACKAGE_VERSION,
  databasePath: DATABASE_PATH,
  opfsAvailable: hasOPFS(),
}
