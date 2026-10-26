// Iconos de trazo (16 px, color del texto) para las barras de herramientas.
const PATHS = {
  /** Rejilla de datos. */
  data: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M2.5 9.75h11M6.5 6.5V13" />
    </>
  ),
  /** Lista de columnas con su tipo. */
  structure: (
    <>
      <rect x="2.5" y="3" width="3" height="2.5" rx="0.5" />
      <rect x="2.5" y="6.75" width="3" height="2.5" rx="0.5" />
      <rect x="2.5" y="10.5" width="3" height="2.5" rx="0.5" />
      <path d="M7.5 4.25h6M7.5 8h6M7.5 11.75h4" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  first: <path d="M4.5 4v8M11.5 4.5 8 8l3.5 3.5" />,
  prev: <path d="M10 4.5 6.5 8l3.5 3.5" />,
  next: <path d="M6 4.5 9.5 8 6 11.5" />,
  last: <path d="M11.5 4v8M4.5 4.5 8 8l-3.5 3.5" />,
  chevronDown: <path d="M5 6.5 8 9.5l3-3" />,
  /** Flecha que entra en una bandeja. */
  import: <path d="M8 2.5v7M5 6.5l3 3 3-3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  /** Flecha que sale de una bandeja. */
  export: <path d="M8 9.5v-7M5 5.5l3-3 3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
}

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="svg-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
