import './style.css'
import {
  closeDuckDB,
  initialEnvironment,
  initializeDuckDB,
  isDuckDBInitialized,
} from './db'
import {
  compareCachedAggregation,
  createPersistenceTestTable,
  importRemoteOrders,
  insertPersistenceRow,
  listRelevantOPFSFiles,
  readCachedAggregation,
  readOrdersSummary,
  readPersistenceState,
  resetDemoStorage,
  writeMonthlyAggregation,
} from './experiments'
import {
  buildNFCorpusIndex,
  EXAMPLE_QUERY,
  inspectNFCorpus,
  loadNFCorpus,
  searchNFCorpus,
  verifyFTS,
} from './nfcorpus'

type ActionName =
  | 'initialize'
  | 'insert-row'
  | 'inspect-persistence'
  | 'import-orders'
  | 'inspect-orders'
  | 'generate-cache'
  | 'read-cache'
  | 'compare-cache'
  | 'check-files'
  | 'close'
  | 'reset'
  | 'verify-fts'
  | 'load-nfcorpus'
  | 'build-nfcorpus-index'
  | 'inspect-nfcorpus'
  | 'search-nfcorpus'

interface ActionDefinition {
  label: string
  needsDatabase: boolean
  run(): Promise<unknown>
}

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app element.')

app.innerHTML = `
  <header class="hero">
    <p class="eyebrow">DuckDB-Wasm · OPFS · Vite</p>
    <h1>Browser persistence reproduction</h1>
    <p class="lede">
      Materialize remote Parquet once, query the persistent local table, and verify an
      OPFS-backed Parquet aggregation across reloads.
    </p>
  </header>

  <main>
    <section class="panel status-panel" aria-labelledby="status-title">
      <div>
        <p class="section-kicker">Session</p>
        <h2 id="status-title">Current state</h2>
      </div>
      <output id="state" class="state state-idle">Not initialized</output>
      <dl id="environment" class="environment"></dl>
    </section>

    <section class="panel" aria-labelledby="actions-title">
      <p class="section-kicker">Manual experiment</p>
      <h2 id="actions-title">Actions</h2>
      <p class="hint">Nothing is imported, inserted, or cached automatically.</p>

      <div class="action-group">
        <h3>1 · Lifecycle & persistence</h3>
        <div class="button-grid">
          <button data-action="initialize">Initialize DuckDB</button>
          <button data-action="insert-row">Insert persistence row</button>
          <button data-action="inspect-persistence">Inspect persistence state</button>
        </div>
      </div>

      <div class="action-group">
        <h3>2 · Remote source & local table</h3>
        <div class="button-grid">
          <button data-action="import-orders">Import remote orders</button>
          <button data-action="inspect-orders">Inspect orders summary</button>
        </div>
      </div>

      <div class="action-group">
        <h3>3 · OPFS Parquet cache</h3>
        <div class="button-grid">
          <button data-action="generate-cache">Generate OPFS aggregation cache</button>
          <button data-action="read-cache">Read cached aggregation</button>
          <button data-action="compare-cache">Compare cache with source table</button>
        </div>
      </div>

      <div class="action-group utilities">
        <h3>4 · NFCorpus full-text search</h3>
        <p class="hint">Run these in order. Search runs inside the DuckDB-Wasm worker.</p>
        <div class="button-grid">
          <button data-action="verify-fts">Verify FTS</button>
          <button data-action="load-nfcorpus">Load corpus</button>
          <button data-action="build-nfcorpus-index">Build index</button>
          <button data-action="inspect-nfcorpus">Inspect NFCorpus state</button>
        </div>
        <label for="nfcorpus-query">NFCorpus query</label>
        <input id="nfcorpus-query" type="search" value="${EXAMPLE_QUERY}" />
        <button data-action="search-nfcorpus">Search</button>
      </div>

      <div class="action-group utilities">
        <h3>Utilities</h3>
        <div class="button-grid">
          <button data-action="check-files">Check OPFS files</button>
          <button data-action="close">Close DuckDB</button>
          <button class="danger" data-action="reset">Reset demo storage</button>
        </div>
      </div>
    </section>

    <section class="panel output-panel" aria-labelledby="result-title">
      <div class="output-heading">
        <div>
          <p class="section-kicker">Latest operation</p>
          <h2 id="result-title">Result</h2>
        </div>
        <span id="duration" class="duration">—</span>
      </div>
      <pre id="result" tabindex="0">Run an action to see its exact result.</pre>
    </section>

    <section class="panel output-panel" aria-labelledby="log-title">
      <p class="section-kicker">Evidence trail</p>
      <h2 id="log-title">Operation log</h2>
      <ol id="log" class="log" aria-live="polite"></ol>
    </section>
  </main>

  <footer>
    Keep DevTools Network open with “Disable cache” while testing. Use the explicit close
    action before closing the browser when the verification calls for a clean shutdown.
  </footer>
`

const stateOutput = document.querySelector<HTMLOutputElement>('#state')!
const environmentList = document.querySelector<HTMLDListElement>('#environment')!
const resultOutput = document.querySelector<HTMLPreElement>('#result')!
const durationOutput = document.querySelector<HTMLSpanElement>('#duration')!
const log = document.querySelector<HTMLOListElement>('#log')!
const buttons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('button[data-action]'),
)
const nfcorpusQuery = document.querySelector<HTMLInputElement>('#nfcorpus-query')!

let busy = false
let resolvedEnvironment: Awaited<ReturnType<typeof initializeDuckDB>> | null = null

function formatJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue,
    2,
  )
}

function renderEnvironment(): void {
  const values: Array<[string, string]> = [
    ['Package', `@duckdb/duckdb-wasm ${initialEnvironment.packageVersion}`],
    ['DuckDB SQL version', resolvedEnvironment?.duckdbVersion ?? 'Not initialized'],
    ['Selected bundle', resolvedEnvironment?.selectedBundle ?? 'Not initialized'],
    ['Database', initialEnvironment.databasePath],
    ['OPFS available', String(initialEnvironment.opfsAvailable)],
    ['Origin', window.location.origin],
    ['Secure context', String(window.isSecureContext)],
    ['Browser', navigator.userAgent],
  ]
  const entries = values.map(([term, description]) => {
    const container = document.createElement('div')
    const termElement = document.createElement('dt')
    const descriptionElement = document.createElement('dd')
    termElement.textContent = term
    descriptionElement.textContent = description
    container.append(termElement, descriptionElement)
    return container
  })
  environmentList.replaceChildren(...entries)
}

function setState(label: string, kind: 'idle' | 'ready' | 'busy' | 'error'): void {
  stateOutput.value = label
  stateOutput.textContent = label
  stateOutput.className = `state state-${kind}`
}

function updateButtons(): void {
  for (const button of buttons) {
    const action = button.dataset.action as ActionName
    const definition = actions[action]
    button.disabled =
      busy ||
      (definition.needsDatabase && !isDuckDBInitialized()) ||
      (action === 'initialize' && isDuckDBInitialized()) ||
      (action === 'close' && !isDuckDBInitialized())
  }
}

function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { name: 'UnknownError', message: String(error) }
}

function addLogEntry(
  label: string,
  status: 'PASS' | 'ERROR' | 'CANCELLED',
  durationMs: number,
  details: unknown,
): void {
  const item = document.createElement('li')
  const heading = document.createElement('div')
  const detail = document.createElement('pre')
  heading.className = 'log-heading'
  heading.textContent = `${new Date().toISOString()} · ${status} · ${label} · ${durationMs.toFixed(1)} ms`
  detail.textContent = formatJson(details)
  item.append(heading, detail)
  log.prepend(item)
}

const actions: Record<ActionName, ActionDefinition> = {
  initialize: {
    label: 'Initialize DuckDB',
    needsDatabase: false,
    async run() {
      resolvedEnvironment = await initializeDuckDB()
      const table = await createPersistenceTestTable()
      renderEnvironment()
      return { environment: resolvedEnvironment, persistenceTable: table.result }
    },
  },
  'insert-row': {
    label: 'Insert persistence row',
    needsDatabase: true,
    run: insertPersistenceRow,
  },
  'inspect-persistence': {
    label: 'Inspect persistence state',
    needsDatabase: true,
    run: readPersistenceState,
  },
  'import-orders': {
    label: 'Import remote orders',
    needsDatabase: true,
    run: importRemoteOrders,
  },
  'inspect-orders': {
    label: 'Inspect orders summary',
    needsDatabase: true,
    run: readOrdersSummary,
  },
  'generate-cache': {
    label: 'Generate OPFS aggregation cache',
    needsDatabase: true,
    run: writeMonthlyAggregation,
  },
  'read-cache': {
    label: 'Read cached aggregation',
    needsDatabase: true,
    run: readCachedAggregation,
  },
  'compare-cache': {
    label: 'Compare cache with source table',
    needsDatabase: true,
    run: compareCachedAggregation,
  },
  'check-files': {
    label: 'Check OPFS files',
    needsDatabase: false,
    run: listRelevantOPFSFiles,
  },
  close: {
    label: 'Close DuckDB',
    needsDatabase: true,
    async run() {
      await closeDuckDB()
      resolvedEnvironment = null
      renderEnvironment()
      return { closed: true, order: ['CHECKPOINT', 'connection.close', 'db.terminate'] }
    },
  },
  reset: {
    label: 'Reset demo storage',
    needsDatabase: false,
    async run() {
      const confirmed = window.confirm(
        'Delete only analytics.duckdb and its helper files plus cache/monthly_totals.parquet?',
      )
      if (!confirmed) return { cancelled: true }
      const reset = await resetDemoStorage()
      resolvedEnvironment = null
      renderEnvironment()
      return reset
    },
  },
  'verify-fts': {
    label: 'Verify FTS',
    needsDatabase: true,
    run: verifyFTS,
  },
  'load-nfcorpus': {
    label: 'Load NFCorpus',
    needsDatabase: true,
    run: loadNFCorpus,
  },
  'build-nfcorpus-index': {
    label: 'Build NFCorpus index',
    needsDatabase: true,
    run: buildNFCorpusIndex,
  },
  'inspect-nfcorpus': {
    label: 'Inspect NFCorpus state',
    needsDatabase: true,
    run: inspectNFCorpus,
  },
  'search-nfcorpus': {
    label: 'Search NFCorpus',
    needsDatabase: true,
    run: () => searchNFCorpus(nfcorpusQuery.value),
  },
}

async function runAction(actionName: ActionName): Promise<void> {
  const action = actions[actionName]
  const started = performance.now()
  busy = true
  setState(`Running: ${action.label}`, 'busy')
  updateButtons()

  try {
    const value = await action.run()
    const durationMs = performance.now() - started
    const cancelled =
      typeof value === 'object' &&
      value !== null &&
      'cancelled' in value &&
      value.cancelled === true
    durationOutput.textContent = `${durationMs.toFixed(1)} ms`
    resultOutput.textContent = formatJson(value)
    addLogEntry(
      action.label,
      cancelled ? 'CANCELLED' : 'PASS',
      durationMs,
      value,
    )
    setState(
      cancelled
        ? 'Reset cancelled'
        : isDuckDBInitialized()
          ? 'DuckDB initialized'
          : 'DuckDB closed',
      isDuckDBInitialized() ? 'ready' : 'idle',
    )
  } catch (error) {
    const durationMs = performance.now() - started
    const details = errorDetails(error)
    durationOutput.textContent = `${durationMs.toFixed(1)} ms`
    resultOutput.textContent = formatJson(details)
    addLogEntry(action.label, 'ERROR', durationMs, details)
    setState(`Error: ${details.message}`, 'error')
  } finally {
    busy = false
    updateButtons()
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    void runAction(button.dataset.action as ActionName)
  })
}

renderEnvironment()
updateButtons()
