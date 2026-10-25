import type { ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: Props) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2>{title}</h2>
        <div className="body">{children}</div>
        <div className="footer">
          <div className="spacer" />
          <button autoFocus onClick={onCancel}>
            Cancelar
          </button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
