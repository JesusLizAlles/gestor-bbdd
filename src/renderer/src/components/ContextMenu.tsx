import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  /** Si devuelve un texto, el menú lo enseña un momento antes de cerrarse (p. ej. «Copiado»). */
  onSelect: () => void | string | Promise<void | string>
}

interface Props {
  /** Posición del clic, en coordenadas de la ventana. */
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** Menú contextual en la posición del ratón; se cierra al elegir, al hacer clic fuera o con Escape. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: y, left: x })
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  // Si no cabe a la derecha o debajo del ratón, se abre hacia el otro lado.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      top: y + rect.height > window.innerHeight - 4 ? Math.max(4, y - rect.height) : y,
      left: x + rect.width > window.innerWidth - 4 ? Math.max(4, x - rect.width) : x
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const select = async (item: MenuItem) => {
    if (busy) return
    setBusy(true)
    try {
      const text = await item.onSelect()
      if (!text) return onClose()
      setStatus({ text, error: false })
      setTimeout(onClose, 700)
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true })
      setBusy(false)
    }
  }

  return createPortal(
    <div ref={ref} className="context-menu" role="menu" style={position} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <div key={item.label} role="menuitem" className={`context-menu-item ${busy ? 'busy' : ''}`} onClick={() => void select(item)}>
          {item.label}
        </div>
      ))}
      {status && <div className={`context-menu-status ${status.error ? 'error' : ''}`}>{status.text}</div>}
    </div>,
    document.body
  )
}
