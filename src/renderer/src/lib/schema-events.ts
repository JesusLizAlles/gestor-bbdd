// Aviso entre componentes de que la estructura de una base de datos ha cambiado (editor de
// estructura), para que el árbol y el autocompletado dejen de usar las columnas que tenían.
const EVENT = 'gestor:schema-changed'

interface SchemaChange {
  sessionId: string
  database: string
}

export function notifySchemaChanged(change: SchemaChange): void {
  window.dispatchEvent(new CustomEvent<SchemaChange>(EVENT, { detail: change }))
}

/** Devuelve la función para darse de baja. */
export function onSchemaChanged(listener: (change: SchemaChange) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<SchemaChange>).detail)
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
