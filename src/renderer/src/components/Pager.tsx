import { useEffect, useRef, useState } from 'react'
import { PAGE_SIZES } from '@shared/types'
import { Icon } from './Icon'

interface Props {
  /** Texto del tramo visible, p. ej. "1–500". */
  range: string
  total: number | null
  counting: boolean
  pageSize: number
  canPrev: boolean
  canNext: boolean
  onCount: () => void
  onFirst: () => void
  onPrev: () => void
  onNext: () => void
  onLast: () => void
  onPageSize: (size: number) => void
}

/** Paginación flotante sobre la rejilla. Clic en el tramo: elegir filas por página. */
export function Pager({ range, total, counting, pageSize, canPrev, canNext, onCount, onFirst, onPrev, onNext, onLast, onPageSize }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="pager" ref={box}>
      <button className="icon" title="Primera página" aria-label="Primera página" disabled={!canPrev} onClick={onFirst}>
        <Icon name="first" />
      </button>
      <button className="icon" title="Página anterior" aria-label="Página anterior" disabled={!canPrev} onClick={onPrev}>
        <Icon name="prev" />
      </button>
      <span className="range" aria-live="polite">
        <button
          className="link range-size"
          title="Filas por página"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {range}
          <Icon name="chevronDown" />
        </button>{' '}
        de{' '}
        {total !== null ? (
          total.toLocaleString('es-ES')
        ) : (
          <button className="link" title="Contar filas" disabled={counting} onClick={onCount}>
            {counting ? '…' : '?'}
          </button>
        )}
      </span>
      <button className="icon" title="Página siguiente" aria-label="Página siguiente" disabled={!canNext} onClick={onNext}>
        <Icon name="next" />
      </button>
      <button className="icon" title="Última página" aria-label="Última página" disabled={!canNext || counting} onClick={onLast}>
        <Icon name="last" />
      </button>
      {open && (
        <div className="pager-menu" role="listbox" aria-label="Filas por página">
          {PAGE_SIZES.map((n) => (
            <div
              key={n}
              role="option"
              aria-selected={n === pageSize}
              className={`pager-option ${n === pageSize ? 'on' : ''}`}
              onClick={() => {
                setOpen(false)
                onPageSize(n)
              }}
            >
              {n} filas por página
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
