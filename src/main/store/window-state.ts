import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Tamaño y posición de la ventana sin maximizar, y si estaba maximizada o a pantalla completa. */
export interface WindowState {
  bounds: Rect
  maximized: boolean
  fullScreen: boolean
}

/** Con qué abrir la ventana: posición solo si se ve en alguna pantalla. */
export interface WindowPlacement {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  fullScreen: boolean
}

/** Cuánto de la barra de título tiene que quedar a la vista para dar la posición por buena. */
const VISIBLE_MARGIN = 100

/**
 * Coloca la ventana como se cerró. Si la pantalla en la que estaba ya no existe (portátil sin el
 * monitor externo) se deja que el sistema la centre, y el tamaño nunca supera la pantalla principal.
 */
export function placeWindow(
  saved: WindowState | null,
  workAreas: Rect[],
  defaults: { width: number; height: number; minWidth: number; minHeight: number }
): WindowPlacement {
  const primary = workAreas[0]
  const fit = (size: number, min: number, max: number | undefined) => Math.max(min, Math.min(size, max ?? size))
  if (!saved) {
    return {
      width: fit(defaults.width, defaults.minWidth, primary?.width),
      height: fit(defaults.height, defaults.minHeight, primary?.height),
      maximized: false,
      fullScreen: false
    }
  }
  const { bounds } = saved
  const titleVisible = workAreas.some(
    (a) =>
      bounds.x + bounds.width >= a.x + VISIBLE_MARGIN &&
      bounds.x <= a.x + a.width - VISIBLE_MARGIN &&
      bounds.y >= a.y &&
      bounds.y <= a.y + a.height - VISIBLE_MARGIN
  )
  const area = titleVisible ? undefined : primary
  return {
    ...(titleVisible ? { x: bounds.x, y: bounds.y } : {}),
    width: fit(bounds.width, defaults.minWidth, area?.width),
    height: fit(bounds.height, defaults.minHeight, area?.height),
    maximized: saved.maximized,
    fullScreen: saved.fullScreen
  }
}

const isRect = (r: unknown): r is Rect =>
  typeof r === 'object' && r !== null && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))

/**
 * window-state.json. Lectura y escritura síncronas: se lee antes de crear la ventana y se escribe
 * al cerrarla, cuando Electron ya no espera a nada asíncrono.
 */
export class WindowStateStore {
  private readonly path: string

  constructor(dir: string) {
    this.path = join(dir, 'window-state.json')
  }

  load(): WindowState | null {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<WindowState>
      if (!isRect(data.bounds)) return null
      return { bounds: data.bounds, maximized: data.maximized === true, fullScreen: data.fullScreen === true }
    } catch {
      // Sin fichero o estropeado: tamaño por defecto.
      return null
    }
  }

  save(state: WindowState): void {
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
