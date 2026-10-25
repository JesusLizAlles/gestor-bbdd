import { describe, expect, it } from 'vitest'
import { formatDate, normalizeValue } from '../src/main/drivers/values'

describe('normalizeValue', () => {
  it.each([
    [null, null],
    [undefined, null],
    ['texto', 'texto'],
    [42, 42],
    [true, true],
    [Number.NaN, 'NaN'],
    [12345678901234567890n, '12345678901234567890'],
    [{ a: 1 }, '{"a":1}'],
    [Buffer.from([0xca, 0xfe]), '0xCAFE']
  ])('%o → %o', (input, expected) => {
    expect(normalizeValue(input)).toBe(expected)
  })

  it('recorta binarios largos indicando el tamaño', () => {
    const out = normalizeValue(Buffer.alloc(100, 0xab)) as string
    expect(out).toMatch(/^0x(AB){64}… \(100 bytes\)$/)
  })

  it('formatea fechas en hora local con milisegundos solo si los hay', () => {
    expect(formatDate(new Date(2026, 9, 25, 8, 5, 3))).toBe('2026-10-25 08:05:03')
    expect(formatDate(new Date(2026, 0, 2, 23, 59, 59, 7))).toBe('2026-01-02 23:59:59.007')
  })
})
