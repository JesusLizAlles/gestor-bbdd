import { useEffect, useState } from 'react'
import { toCsv, toJson, toSqlInserts } from '@shared/format'
import type { Engine, QueryResult } from '@shared/types'
import { DataGrid } from './DataGrid'

interface Props {
  engine: Engine
  results: QueryResult[]
  running: boolean
  message: { kind: 'error' | 'info'; text: string } | null
  maxRows: number
}

function tabLabel(r: QueryResult, i: number): string {
  if (r.error) return `Error`
  if (r.columns.length === 0) return `Sentencia ${i + 1}`
  return `Resultado ${i + 1} (${r.rows.length}${r.truncated ? '+' : ''})`
}

export function ResultsPanel({ engine, results, running, message, maxRows }: Props) {
  const [active, setActive] = useState(0)
  const [exported, setExported] = useState<string | null>(null)

  // Al llegar resultados nuevos se muestra el último (o el error, que siempre es el último).
  useEffect(() => {
    setActive(Math.max(0, results.length - 1))
    setExported(null)
  }, [results])

  const current = results[active]

  const exportAs = async (kind: 'csv' | 'excel' | 'json' | 'sql') => {
    if (!current) return
    const content =
      kind === 'csv' ? toCsv(current) : kind === 'excel' ? toCsv(current, { excel: true }) : kind === 'json' ? toJson(current) : toSqlInserts(current, engine)
    const format = kind === 'excel' ? 'csv' : kind
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    try {
      const path = await window.api.exportFile({ defaultName: `resultado-${stamp}`, format, content })
      if (path) setExported(`Guardado en ${path}`)
    } catch (err) {
      setExported(`No se pudo exportar: ${(err as Error).message}`)
    }
  }

  return (
    <div className="results">
      <div className="results-header">
        {results.map((r, i) => (
          <div
            key={i}
            className={`result-tab ${i === active ? 'active' : ''} ${r.error ? 'error' : ''}`}
            onClick={() => setActive(i)}
            title={r.statement}
          >
            {tabLabel(r, i)}
          </div>
        ))}
        {results.length === 0 && <span className="note">{running ? 'Ejecutando…' : 'Sin resultados'}</span>}
        <div className="spacer" />
        {exported && <span className="note">{exported}</span>}
        {current && current.columns.length > 0 && (
          <select
            value=""
            style={{ width: 'auto' }}
            onChange={(e) => {
              void exportAs(e.target.value as 'csv' | 'excel' | 'json' | 'sql')
              e.target.value = ''
            }}
          >
            <option value="" disabled>
              Exportar…
            </option>
            <option value="csv">CSV</option>
            <option value="excel">CSV para Excel (;)</option>
            <option value="json">JSON</option>
            <option value="sql">SQL INSERT</option>
          </select>
        )}
      </div>

      {message && <div className={`result-message ${message.kind === 'error' ? 'error' : ''}`}>{message.text}</div>}

      {!message && current?.error && (
        <div className="result-message error">
          {current.error}
          <div className="stmt">{current.statement}</div>
        </div>
      )}

      {!message && current && !current.error && current.columns.length === 0 && (
        <div className="result-message">
          {current.affectedRows ?? 0} fila(s) afectada(s) · {current.durationMs} ms
          <div className="stmt">{current.statement}</div>
        </div>
      )}

      {!message && current && !current.error && current.columns.length > 0 && (
        <>
          {current.truncated && (
            <div className="warning-strip">
              Se muestran las primeras {maxRows} filas. Añade LIMIT/TOP o sube el límite en la barra de herramientas para ver más.
            </div>
          )}
          <DataGrid columns={current.columns} rows={current.rows} />
        </>
      )}
    </div>
  )
}
