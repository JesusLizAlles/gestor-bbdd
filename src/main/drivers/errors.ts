/** Traduce errores de red y autenticación de los drivers a mensajes claros en español. */
export function friendlyDbError(err: unknown, target: string): Error {
  const e = err as { code?: string; errno?: number; message?: string; originalError?: { code?: string; message?: string } }
  const code = e.code ?? e.originalError?.code
  const message = e.message ?? String(err)
  switch (code) {
    case 'ECONNREFUSED':
      return new Error(`${target} rechazó la conexión. ¿Está el servidor arrancado y el puerto abierto?`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Error(`No se encuentra el servidor ${target}`)
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      return new Error(`Tiempo de espera agotado conectando a ${target}`)
    case 'ECONNRESET':
      return new Error(`${target} cerró la conexión inesperadamente`)
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ELOGIN':
      return new Error(`Acceso denegado: ${message}`)
    case 'ER_BAD_DB_ERROR':
      return new Error(`La base de datos no existe: ${message}`)
    case 'HANDSHAKE_SSL_ERROR':
    case 'HANDSHAKE_NO_SSL_SUPPORT':
      return new Error(`Error de TLS: ${message}`)
  }
  if (/self[- ]signed|unable to verify|certificate/i.test(message)) {
    return new Error(`No se pudo verificar el certificado TLS del servidor (${message}). Desactiva "Verificar certificado" o indica la CA.`)
  }
  return err instanceof Error ? err : new Error(message)
}
