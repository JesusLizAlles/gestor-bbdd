import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/types'
import { describeUpdateError, htmlToText, Updater, type UpdaterBackend } from '../src/main/updater'

/** Sustituto de electron-updater: emite los mismos eventos cuando el test lo indica. */
class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = true
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    return null
  })
  downloadUpdate = vi.fn(async () => null)
  quitAndInstall = vi.fn()
}

function setup(backend: FakeBackend | null = new FakeBackend()) {
  const sent: UpdateState[] = []
  const updater = new Updater({ backend, currentVersion: '0.3.0', unsupportedReason: 'desarrollo', send: (s) => sent.push(s) })
  return { updater, backend: backend!, sent, last: () => sent.at(-1)! }
}

describe('Updater', () => {
  it('no descarga sola: la descarga y la instalación las decide el usuario', () => {
    const { backend } = setup()
    expect(backend.autoDownload).toBe(false)
    expect(backend.autoInstallOnAppQuit).toBe(true)
  })

  it('comprobación manual sin novedades', async () => {
    const { updater, backend, last } = setup()
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('update-not-available', { version: '0.3.0' })
      return null
    })
    await updater.check(true)
    expect(last()).toEqual({ status: 'not-available', currentVersion: '0.3.0', manual: true })
  })

  it('versión nueva: notas en texto plano, descarga con progreso e instalación', async () => {
    const { updater, backend, sent, last } = setup()
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('update-available', {
        version: '0.3.1',
        releaseDate: '2026-11-02T10:00:00Z',
        releaseNotes: '<h2>Novedades</h2><ul><li>Historial &amp; filtros</li><li>Arreglos</li></ul>'
      })
      return null
    })
    await updater.check(false)
    expect(last()).toMatchObject({
      status: 'available',
      version: '0.3.1',
      manual: false,
      releaseNotes: 'Novedades\n• Historial & filtros\n• Arreglos'
    })

    backend.downloadUpdate.mockImplementationOnce(async () => {
      backend.emit('download-progress', { percent: 42.6 })
      backend.emit('update-downloaded', { version: '0.3.1' })
      return null
    })
    await updater.download()
    expect(sent.map((s) => s.status)).toContain('downloading')
    expect(sent.find((s) => s.status === 'downloading' && s.percent === 43)).toBeTruthy()
    // Las notas se conservan aunque el evento de descarga no las traiga.
    expect(last()).toMatchObject({ status: 'downloaded', version: '0.3.1', percent: 100, releaseNotes: expect.stringContaining('Arreglos') })

    updater.install()
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('no instala ni descarga fuera de su momento', async () => {
    const { updater, backend } = setup()
    await updater.download()
    updater.install()
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })

  it('un fallo durante la descarga deja la versión disponible para reintentarlo', async () => {
    const { updater, backend, last } = setup()
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('update-available', { version: '0.3.1' })
      return null
    })
    await updater.check(true)
    backend.downloadUpdate.mockImplementationOnce(async () => {
      backend.emit('download-progress', { percent: 10 })
      backend.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      throw new Error('net::ERR_CONNECTION_RESET')
    })
    await updater.download()
    expect(last()).toMatchObject({ status: 'available', version: '0.3.1', error: expect.stringMatching(/conexión/) })
  })

  it('no vuelve a buscar mientras descarga o con la descarga lista', async () => {
    const { updater, backend } = setup()
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('update-available', { version: '0.3.1' })
      return null
    })
    await updater.check(true)
    backend.downloadUpdate.mockImplementationOnce(async () => {
      backend.emit('update-downloaded', { version: '0.3.1' })
      return null
    })
    await updater.download()
    await updater.check(false)
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('sin backend (desarrollo o Linux sin AppImage) informa del motivo y no hace nada', async () => {
    const { updater } = setup(null)
    expect(await updater.check(true)).toEqual({ status: 'unsupported', currentVersion: '0.3.0', reason: 'desarrollo' })
  })

  it('descarga manual (macOS sin firmar): avisa igual, pero «Descargar» abre la versión en el navegador', async () => {
    const backend = new FakeBackend()
    const manualDownload = vi.fn()
    const sent: UpdateState[] = []
    const updater = new Updater({ backend, currentVersion: '0.3.0', manualDownload, send: (s) => sent.push(s) })
    expect(backend.autoInstallOnAppQuit).toBe(false)
    expect(updater.get()).toMatchObject({ status: 'idle', manualInstall: true })

    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('update-available', { version: '0.3.1' })
      return null
    })
    await updater.check(false)
    expect(sent.at(-1)).toMatchObject({ status: 'available', version: '0.3.1', manualInstall: true })

    expect(await updater.download()).toMatchObject({ status: 'available', version: '0.3.1' })
    expect(manualDownload).toHaveBeenCalledWith('0.3.1')
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
    updater.install()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })

  it('las comprobaciones automáticas arrancan con retraso y se repiten', () => {
    vi.useFakeTimers()
    try {
      const { updater, backend } = setup()
      updater.startAutoCheck(10_000, 60_000)
      vi.advanceTimersByTime(9_999)
      expect(backend.checkForUpdates).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
      updater.stop()
      vi.advanceTimersByTime(120_000)
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('htmlToText / describeUpdateError', () => {
  it('quita etiquetas y scripts sin ejecutarlos y decodifica entidades', () => {
    expect(htmlToText('<p>Uno<br>Dos</p><script>alert(1)</script><p>&lt;b&gt; &#241; &#x00e1;</p>')).toBe('Uno\nDos\n<b> ñ á')
  })

  it('traduce los errores habituales', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toMatch(/conexión/)
    expect(describeUpdateError(new Error('Cannot find latest.yml in the latest release artifacts'))).toMatch(/datos de actualización/)
    expect(describeUpdateError(new Error('sha512 checksum mismatch, expected x'))).toMatch(/no coincide/)
    expect(describeUpdateError(new Error('algo raro'))).toBe('No se pudo actualizar: algo raro')
  })
})
