import { describe, expect, it } from 'vitest'
import { formatJson, parseJsonCell } from '@shared/json'

describe('parseJsonCell', () => {
  it('reconoce objetos y arrays, con espacios alrededor', () => {
    expect(parseJsonCell('{"a":1}')).toEqual({ kind: 'object', entries: [['a', { kind: 'number', raw: '1' }]] })
    expect(parseJsonCell('  [1, "x", true, false, null]\n')).toEqual({
      kind: 'array',
      items: [
        { kind: 'number', raw: '1' },
        { kind: 'string', value: 'x' },
        { kind: 'boolean', value: true },
        { kind: 'boolean', value: false },
        { kind: 'null' }
      ]
    })
    expect(parseJsonCell('{}')).toEqual({ kind: 'object', entries: [] })
    expect(parseJsonCell('[ ]')).toEqual({ kind: 'array', items: [] })
  })

  it('no trata como JSON escalares, textos ni valores que no son cadena', () => {
    for (const v of ['hola', '123', 'true', '"texto"', '', null, 42, true, undefined]) expect(parseJsonCell(v)).toBeNull()
  })

  it('descarta lo que parece JSON pero no lo es', () => {
    for (const v of [
      '{a:1}',
      "{'a':1}",
      '{"a":1,}',
      '[1,2,]',
      '{"a":1} extra',
      '{"a":01}',
      '{"a":NaN}',
      '[1 2]',
      '{"a"}',
      '{"a":"línea\nrota"}',
      '[tru]',
      '{"a":[1}',
      '[1] [2]'
    ])
      expect(parseJsonCell(v), v).toBeNull()
  })

  it('conserva el texto de los números y el orden de las claves', () => {
    const node = parseJsonCell('{"b":1.50,"2":12345678901234567890,"a":-1e-3}')
    expect(node).toEqual({
      kind: 'object',
      entries: [
        ['b', { kind: 'number', raw: '1.50' }],
        ['2', { kind: 'number', raw: '12345678901234567890' }],
        ['a', { kind: 'number', raw: '-1e-3' }]
      ]
    })
  })

  it('decodifica los escapes de las cadenas y las claves', () => {
    expect(parseJsonCell('{"cla\\"ve":"a\\nb \\u00e9 \\/"}')).toEqual({
      kind: 'object',
      entries: [['cla"ve', { kind: 'string', value: 'a\nb é /' }]]
    })
  })

  it('analiza anidamientos y no revienta con uno absurdo', () => {
    expect(parseJsonCell('{"a":{"b":[{"c":[]}]}}')).not.toBeNull()
    expect(parseJsonCell('['.repeat(10_000) + ']'.repeat(10_000))).toBeNull()
  })
})

describe('formatJson', () => {
  it('sangra con 2 espacios y respeta números y orden originales', () => {
    const node = parseJsonCell('{"z":1.50,"1":[true,null,{}],"s":"a\\"b","v":[]}')!
    expect(formatJson(node)).toBe('{\n  "z": 1.50,\n  "1": [\n    true,\n    null,\n    {}\n  ],\n  "s": "a\\"b",\n  "v": []\n}')
  })
})
