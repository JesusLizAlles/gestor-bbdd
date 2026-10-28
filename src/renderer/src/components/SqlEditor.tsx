import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { ConsoleState, Engine } from '@shared/types'
import { languageFor, monaco, registerCompletion } from '../lib/monaco'

export interface EditorCommands {
  /** Sentencia bajo el cursor (o selección). */
  runCurrent: (text: string, selection: boolean, cursorOffset: number) => void
  /** Script completo. */
  runAll: (text: string) => void
}

/** Lo que hay en el editor y dónde: lo que se guarda de una consola (sin su base de datos). */
export type EditorState = Omit<ConsoleState, 'database'>

export interface SqlEditorHandle {
  /** Añade una sentencia al final, separada por una línea en blanco, conservando el deshacer. */
  appendStatement: (statement: string) => void
  /**
   * Inserta una sentencia donde está el cursor (reemplazando la selección), en su propia línea
   * y terminada en `;`, y deja el cursor detrás.
   */
  insertAtCursor: (statement: string) => void
  /** Lo mismo que Ctrl+Enter: sentencia bajo el cursor o selección. */
  runCurrent: () => void
  runAll: () => void
}

interface Props {
  engine: Engine
  /** Texto inicial. El editor no es controlado: los cambios externos van por `appendStatement`. */
  initialValue: string
  /** Selección y desplazamiento con los que se abre (consola recuperada). */
  initialView?: Pick<EditorState, 'selection' | 'scrollTop'>
  /** Cada cambio de texto, cursor/selección o desplazamiento, con el estado completo. */
  onStateChange?: (state: EditorState) => void
  commands: EditorCommands
  ref?: Ref<SqlEditorHandle>
}

/** Editor Monaco con atajos Ctrl+Enter (sentencia actual) y Ctrl+Shift+Enter (todo). */
export function SqlEditor({ engine, initialValue, initialView, onStateChange, commands, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const latest = useRef({ onStateChange, commands })
  latest.current = { onStateChange, commands }
  const runRef = useRef<(all: boolean) => void>(() => {})
  /**
   * Estado del editor al destruirlo. Si el mismo componente lo vuelve a crear (StrictMode lo hace
   * en desarrollo), parte de ahí y no del texto inicial, que ya no incluiría lo añadido después.
   */
  const kept = useRef<EditorState | null>(null)

  useImperativeHandle(ref, () => ({
    appendStatement(statement) {
      const instance = editor.current
      const model = instance?.getModel()
      if (!instance || !model) return
      const current = model.getValue()
      const separator = current.trim() === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
      const text = `${separator}${statement};\n`
      const end = model.getFullModelRange().getEndPosition()
      const range = new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column)
      instance.executeEdits('externo', [{ range, text }])
      instance.setPosition(model.getFullModelRange().getEndPosition())
      instance.revealLine(model.getLineCount())
      instance.focus()
    },
    insertAtCursor(statement) {
      const instance = editor.current
      const model = instance?.getModel()
      const selection = instance?.getSelection()
      if (!instance || !model || !selection) return
      const body = /;\s*$/.test(statement) ? statement.trim() : `${statement.trim()};`
      const before = model.getValueInRange(new monaco.Range(1, 1, selection.startLineNumber, selection.startColumn))
      const after = model.getValueInRange(
        new monaco.Range(selection.endLineNumber, selection.endColumn, model.getLineCount(), model.getLineMaxColumn(model.getLineCount()))
      )
      const prefix = before.trim() === '' || before.endsWith('\n') ? '' : '\n'
      const suffix = after.startsWith('\n') || after === '' ? '' : '\n'
      instance.executeEdits('historial', [{ range: selection, text: `${prefix}${body}${suffix}` }])
      const end = instance.getPosition()
      if (end && suffix) instance.setPosition({ lineNumber: end.lineNumber - 1, column: model.getLineMaxColumn(end.lineNumber - 1) })
      instance.focus()
    },
    runCurrent: () => runRef.current(false),
    runAll: () => runRef.current(true)
  }))

  useEffect(() => {
    registerCompletion()
    const start = kept.current
    const view = start ?? initialView
    const instance = monaco.editor.create(host.current!, {
      value: start?.text ?? initialValue,
      language: languageFor(engine),
      theme: 'gestor-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      renderLineHighlight: 'all',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true
    })
    editor.current = instance

    const run = (all: boolean) => {
      const model = instance.getModel()
      if (!model) return
      if (all) return latest.current.commands.runAll(model.getValue())
      const selection = instance.getSelection()
      if (selection && !selection.isEmpty()) {
        return latest.current.commands.runCurrent(model.getValueInRange(selection), true, 0)
      }
      const position = instance.getPosition()
      const offset = position ? model.getOffsetAt(position) : 0
      latest.current.commands.runCurrent(model.getValue(), false, offset)
    }
    runRef.current = run
    instance.addAction({
      id: 'gestor.runCurrent',
      label: 'Ejecutar sentencia actual',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => run(false)
    })
    instance.addAction({
      id: 'gestor.runAll',
      label: 'Ejecutar todo el script',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => run(true)
    })
    if (view) {
      const { startLine, startColumn, endLine, endColumn } = view.selection
      instance.setSelection(new monaco.Selection(startLine, startColumn, endLine, endColumn))
      instance.setScrollTop(view.scrollTop)
    }

    // El texto se lee solo cuando cambia; mover el cursor o desplazarse reutiliza el último.
    let text = instance.getValue()
    const emit = () => {
      const s = instance.getSelection()
      if (!s) return
      latest.current.onStateChange?.({
        text,
        selection: { startLine: s.startLineNumber, startColumn: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn },
        scrollTop: instance.getScrollTop()
      })
    }
    const subs = [
      instance.onDidChangeModelContent(() => {
        text = instance.getValue()
        emit()
      }),
      instance.onDidChangeCursorSelection(emit),
      instance.onDidScrollChange((e) => e.scrollTopChanged && emit())
    ]
    instance.focus()
    return () => {
      for (const sub of subs) sub.dispose()
      const s = instance.getSelection()
      if (s) {
        kept.current = {
          text: instance.getValue(),
          selection: { startLine: s.startLineNumber, startColumn: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn },
          scrollTop: instance.getScrollTop()
        }
      }
      instance.dispose()
      editor.current = null
    }
    // Se crea una vez por consola (el padre usa key={consola}); el motor se sincroniza abajo.
  }, [])

  useEffect(() => {
    const model = editor.current?.getModel()
    if (model) monaco.editor.setModelLanguage(model, languageFor(engine))
  }, [engine])

  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}
