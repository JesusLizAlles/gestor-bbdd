import { useState, type ReactNode } from 'react'
import { formatJson, type JsonNode } from '@shared/json'

/** Niveles que se ven desplegados al abrir un JSON; el resto, plegado con su resumen. */
const OPEN_DEPTH = 2

/** Despliegue forzado por "Expandir todo" / "Contraer todo"; null = según la profundidad. */
type ForceOpen = boolean | null

function summary(node: Extract<JsonNode, { kind: 'object' | 'array' }>): string {
  const n = node.kind === 'object' ? node.entries.length : node.items.length
  const noun = node.kind === 'object' ? (n === 1 ? 'clave' : 'claves') : n === 1 ? 'elemento' : 'elementos'
  return `${n} ${noun}`
}

function Scalar({ node }: { node: JsonNode }) {
  switch (node.kind) {
    case 'string':
      return <span className="json-string">{JSON.stringify(node.value)}</span>
    case 'number':
      return <span className="json-number">{node.raw}</span>
    case 'boolean':
      return <span className="json-literal">{String(node.value)}</span>
    case 'null':
      return <span className="json-literal">null</span>
    default:
      return null
  }
}

function Label({ name }: { name: string | number | undefined }) {
  if (name === undefined) return null
  return (
    <>
      {typeof name === 'number' ? <span className="json-index">{name}</span> : <span className="json-key">{JSON.stringify(name)}</span>}
      <span className="json-punct">: </span>
    </>
  )
}

function Branch({
  node,
  name,
  depth,
  force,
  last
}: {
  node: JsonNode
  name?: string | number
  depth: number
  force: ForceOpen
  last: boolean
}): ReactNode {
  const [open, setOpen] = useState(force ?? depth < OPEN_DEPTH)
  const comma = last ? null : <span className="json-punct">,</span>

  if (node.kind !== 'object' && node.kind !== 'array') {
    return (
      <div className="json-line">
        <span className="json-toggle" />
        <Label name={name} />
        <Scalar node={node} />
        {comma}
      </div>
    )
  }

  const [lb, rb] = node.kind === 'object' ? ['{', '}'] : ['[', ']']
  const children: [string | number, JsonNode][] =
    node.kind === 'object' ? node.entries : node.items.map((item, i): [number, JsonNode] => [i, item])
  if (children.length === 0) {
    return (
      <div className="json-line">
        <span className="json-toggle" />
        <Label name={name} />
        <span className="json-punct">{lb + rb}</span>
        {comma}
      </div>
    )
  }

  const toggle = () => setOpen(!open)
  return (
    <>
      <div className="json-line json-branch" onClick={toggle} title={open ? 'Plegar' : 'Desplegar'}>
        <span className="json-toggle">{open ? '▾' : '▸'}</span>
        <Label name={name} />
        <span className="json-punct">{lb}</span>
        {!open && (
          <>
            <span className="json-summary"> {summary(node)} </span>
            <span className="json-punct">{rb}</span>
            {comma}
          </>
        )}
      </div>
      {open && (
        <>
          <div className="json-children">
            {children.map(([key, child], i) => (
              <Branch key={i} node={child} name={key} depth={depth + 1} force={force} last={i === children.length - 1} />
            ))}
          </div>
          <div className="json-line">
            <span className="json-toggle" />
            <span className="json-punct">{rb}</span>
            {comma}
          </div>
        </>
      )}
    </>
  )
}

/**
 * Visor de un JSON guardado en una celda: árbol con colores y nodos plegables, o texto con sangría.
 * `id` identifica la celda: al cambiar de celda el árbol vuelve a su despliegue inicial.
 */
export function JsonView({ node, id }: { node: JsonNode; id: string }) {
  const [mode, setMode] = useState<'tree' | 'text'>('tree')
  // Cada "Expandir/Contraer todo" monta de nuevo el árbol con el despliegue forzado.
  const [force, setForce] = useState<{ open: ForceOpen; gen: number }>({ open: null, gen: 0 })
  const [forcedFor, setForcedFor] = useState(id)
  if (forcedFor !== id) {
    setForcedFor(id)
    setForce({ open: null, gen: force.gen + 1 })
  }
  const expandAll = (open: boolean) => setForce({ open, gen: force.gen + 1 })

  return (
    <div className="json-view">
      <div className="json-toolbar">
        <span className="json-badge">JSON</span>
        <button className={`compact ${mode === 'tree' ? 'on' : ''}`} onClick={() => setMode('tree')}>
          Árbol
        </button>
        <button className={`compact ${mode === 'text' ? 'on' : ''}`} onClick={() => setMode('text')}>
          Texto
        </button>
        {mode === 'tree' && (
          <>
            <button className="compact" title="Desplegar todos los nodos" onClick={() => expandAll(true)}>
              Expandir todo
            </button>
            <button className="compact" title="Plegar todos los nodos" onClick={() => expandAll(false)}>
              Contraer todo
            </button>
          </>
        )}
        <button className="compact" title="Copiar el JSON con sangría" onClick={() => void navigator.clipboard.writeText(formatJson(node))}>
          Copiar formateado
        </button>
      </div>
      <div className="json-body">
        {mode === 'tree' ? (
          <Branch key={`${id}#${force.gen}`} node={node} depth={0} force={force.open} last />
        ) : (
          <pre className="json-text">{formatJson(node)}</pre>
        )}
      </div>
    </div>
  )
}
