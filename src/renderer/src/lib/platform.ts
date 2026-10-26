// Diferencias de teclado entre macOS y Windows/Linux.

export const isMac = navigator.userAgent.includes('Mac')

/** Alt+Insert (fila nueva); en macOS no hay Insert y se usa Cmd+N, como en DataGrip. */
export function isAddRowKey(e: { key: string; altKey: boolean; metaKey: boolean }): boolean {
  return (e.altKey && e.key === 'Insert') || (isMac && e.metaKey && e.key.toLowerCase() === 'n')
}

/** Supr; la tecla «delete» del Mac es Retroceso (Supr solo existe como Fn+delete). */
export function isDeleteKey(e: { key: string }): boolean {
  return e.key === 'Delete' || (isMac && e.key === 'Backspace')
}

const MAC_KEYS: [RegExp, string][] = [
  [/Alt\+Insert/g, '⌘N'],
  [/Ctrl\+/g, '⌘'],
  [/Ctrl\b/g, '⌘'],
  [/Alt\+/g, '⌥'],
  [/(Shift|Mayús)\+/g, '⇧'],
  [/Supr/g, '⌫']
]

/** Atajo escrito como en Windows («Ctrl+Shift+Enter») tal como se pulsa en esta plataforma. */
export function keys(text: string): string {
  return isMac ? MAC_KEYS.reduce((s, [re, mac]) => s.replace(re, mac), text) : text
}
