import type { McpApprovalRequest } from '@shared/types'

const ENV_LABEL = { dev: 'Desarrollo', test: 'Pruebas', prod: 'PRODUCCIÓN' } as const

/** Un agente quiere ejecutar SQL que modifica: el usuario lo lee y decide. Por defecto, rechazar. */
export function McpApprovalDialog({
  request,
  pending,
  onAnswer
}: {
  request: McpApprovalRequest
  /** Cuántas más esperan detrás de esta. */
  pending: number
  onAnswer: (approved: boolean) => void
}) {
  const prod = request.environment === 'prod'
  const count = request.statements.length
  return (
    <div className="modal-overlay">
      <div
        className="dialog wide"
        role="alertdialog"
        aria-label="Aprobar SQL del agente"
        onKeyDown={(e) => e.key === 'Escape' && onAnswer(false)}
      >
        <h2>Un agente de IA quiere modificar la base de datos</h2>
        <div className="body">
          <p>
            <span className={`env-dot env-${request.environment}`} /> <strong>{request.connectionName}</strong>
            {request.database && <> · {request.database}</>} ·{' '}
            {prod ? <span className="badge prod">{ENV_LABEL.prod}</span> : ENV_LABEL[request.environment]}
          </p>
          <p className="note">
            {count === 1 ? 'Esta sentencia se ejecutará' : `Estas ${count} sentencias se ejecutarán en orden`} solo si pulsas
            «Ejecutar». Revisa sobre todo los UPDATE y DELETE sin WHERE.
          </p>
          <pre className="review-sql">{request.statements.join(';\n\n')}</pre>
          {pending > 0 && <p className="note">Hay {pending} petición(es) más esperando.</p>}
        </div>
        <div className="footer">
          <span className="note">Si no respondes en 5 minutos, se rechaza.</span>
          <div className="spacer" />
          <button autoFocus onClick={() => onAnswer(false)}>
            Rechazar
          </button>
          <button className={prod ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
            Ejecutar
          </button>
        </div>
      </div>
    </div>
  )
}
