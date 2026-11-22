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
    // PostgreSQL: contraseña incorrecta y conexión no permitida por pg_hba.conf.
    case '28P01':
    case '28000':
      return new Error(`Acceso denegado: ${message}`)
    case 'ER_BAD_DB_ERROR':
    case '3D000':
      return new Error(`La base de datos no existe: ${message}`)
    case 'HANDSHAKE_SSL_ERROR':
    case 'HANDSHAKE_NO_SSL_SUPPORT':
      return new Error(`Error de TLS: ${message}`)
  }
  if (/does not support SSL/i.test(message)) {
    return new Error(`Error de TLS: el servidor no admite conexiones cifradas. Desactiva TLS en la conexión.`)
  }
  if (/connection timeout|timeout expired/i.test(message)) {
    return new Error(`Tiempo de espera agotado conectando a ${target}`)
  }
  if (/self[- ]signed|unable to verify|certificate/i.test(message)) {
    return new Error(`No se pudo verificar el certificado TLS del servidor (${message}). Desactiva "Verificar certificado" o indica la CA.`)
  }
  return err instanceof Error ? err : new Error(message)
}

/** Fallo al aplicar cambios de estructura; `applied` = sentencias que ya se habían aplicado. */
export class DdlError extends Error {
  constructor(
    message: string,
    readonly applied: number
  ) {
    super(message)
  }
}

export function rowChangedError(label: string, affected: number): Error {
  return new Error(
    affected === 0
      ? `No se guardó nada: ${label} ya no existe o su clave ha cambiado. Recarga la tabla.`
      : `No se guardó nada: el cambio de ${label} afectaría a ${affected} filas en lugar de a una.`
  )
}
