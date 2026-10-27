import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placeWindow, WindowStateStore, type WindowState } from '../src/main/store/window-state'

const defaults = { width: 1400, height: 900, minWidth: 900, minHeight: 600 }
const laptop = { x: 0, y: 25, width: 1440, height: 875 }
const external = { x: 1440, y: 0, width: 2560, height: 1415 }
const saved = (bounds: WindowState['bounds'], maximized = false, fullScreen = false): WindowState => ({ bounds, maximized, fullScreen })

describe('placeWindow', () => {
  it('sin estado guardado: tamaño por defecto, sin pasarse de la pantalla principal', () => {
    expect(placeWindow(null, [external], defaults)).toEqual({ width: 1400, height: 900, maximized: false, fullScreen: false })
    expect(placeWindow(null, [laptop], defaults)).toEqual({ width: 1400, height: 875, maximized: false, fullScreen: false })
  })

  it('vuelve a abrir donde y como se cerró, también maximizada o a pantalla completa', () => {
    const bounds = { x: 1600, y: 100, width: 1800, height: 1100 }
    expect(placeWindow(saved(bounds, true), [laptop, external], defaults)).toEqual({ ...bounds, maximized: true, fullScreen: false })
    expect(placeWindow(saved(bounds, false, true), [laptop, external], defaults)).toMatchObject({ fullScreen: true })
  })

  it('si la pantalla donde estaba ya no está, deja que el sistema la coloque y la ajusta a la principal', () => {
    expect(placeWindow(saved({ x: 1600, y: 100, width: 1800, height: 1100 }, true), [laptop], defaults)).toEqual({
      width: 1440,
      height: 875,
      maximized: true,
      fullScreen: false
    })
  })

  it('descarta la posición si la barra de título queda fuera de la vista', () => {
    expect(placeWindow(saved({ x: 100, y: -500, width: 1000, height: 700 }), [laptop], defaults)).not.toHaveProperty('x')
    expect(placeWindow(saved({ x: -950, y: 100, width: 1000, height: 700 }), [laptop], defaults)).not.toHaveProperty('x')
  })

  it('respeta el tamaño mínimo', () => {
    expect(placeWindow(saved({ x: 10, y: 40, width: 200, height: 100 }), [laptop], defaults)).toMatchObject({ width: 900, height: 600 })
  })
})

describe('WindowStateStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-bbdd-ventana-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('guarda y recupera el estado', () => {
    const state = saved({ x: 10, y: 40, width: 1200, height: 800 }, true)
    new WindowStateStore(dir).save(state)
    expect(new WindowStateStore(dir).load()).toEqual(state)
  })

  it('sin fichero o con un fichero estropeado devuelve null', async () => {
    expect(new WindowStateStore(dir).load()).toBeNull()
    await writeFile(join(dir, 'window-state.json'), '{"bounds": {"x": "a"}}')
    expect(new WindowStateStore(dir).load()).toBeNull()
    await writeFile(join(dir, 'window-state.json'), 'no es json')
    expect(new WindowStateStore(dir).load()).toBeNull()
  })
})
