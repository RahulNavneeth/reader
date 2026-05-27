import { describe, it, expect } from 'vitest'
import {
  parseTemplateSource,
  parseTemplateSourceStrict,
} from './templateMetadata.js'

describe('templateMetadata', () => {
  it('returns empty metadata for a file with no frontmatter', () => {
    const src = '# Title\n\nBody text.'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars).toEqual([])
    expect(r.body).toBe(src)
  })

  it('does not mis-detect a `---` horizontal rule as frontmatter', () => {
    const src = '# Title\n\n---\n\nMore body.'
    const r = parseTemplateSource(src)
    expect(r.body).toBe(src)
    expect(r.metadata.vars).toEqual([])
  })

  it('extracts vars schema with type, label, options, required', () => {
    const src = [
      '---',
      'vars:',
      '  - name: type',
      '    label: Workout type',
      '    type: select',
      '    options: [Upper Body, Lower Body, Cardio]',
      '    required: true',
      '  - name: notes',
      '    type: textarea',
      '    default: ""',
      '---',
      '# Workout',
      '',
      'Today is {{type}}.',
    ].join('\n')
    const r = parseTemplateSource(src)
    expect(r.body.startsWith('# Workout')).toBe(true)
    expect(r.metadata.vars).toHaveLength(2)
    expect(r.metadata.vars[0]).toMatchObject({
      name: 'type',
      label: 'Workout type',
      type: 'select',
      options: ['Upper Body', 'Lower Body', 'Cardio'],
      required: true,
    })
    expect(r.metadata.vars[1]).toMatchObject({ name: 'notes', type: 'textarea', default: '' })
  })

  it('drops var entries without a name field', () => {
    const src = '---\nvars:\n  - label: nameless\n  - name: real\n---\nbody'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars).toHaveLength(1)
    expect(r.metadata.vars[0].name).toBe('real')
  })

  it('coerces non-string defaults to strings', () => {
    const src = '---\nvars:\n  - name: n\n    default: 7\n  - name: b\n    default: true\n---\nbody'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars[0].default).toBe('7')
    expect(r.metadata.vars[1].default).toBe('true')
  })

  it('ignores unknown var types', () => {
    const src = '---\nvars:\n  - name: x\n    type: rocketship\n---\nbody'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars[0].type).toBeUndefined()
  })

  it('folds legacy schedule + schedule_vars into schedules array', () => {
    const src = [
      '---',
      'schedule: "0 6 * * 1,4"',
      'schedule_vars:',
      '  type: Upper Body',
      '  upper: "true"',
      'schedule_path: "logs/{{date}}-workout.md"',
      'schedule_title: "Workout {{date}}"',
      '---',
      'body',
    ].join('\n')
    const r = parseTemplateSource(src)
    expect(r.metadata.schedule).toBe('0 6 * * 1,4')
    expect(r.metadata.schedules).toHaveLength(1)
    expect(r.metadata.schedules[0]).toMatchObject({
      cron: '0 6 * * 1,4',
      vars: { type: 'Upper Body', upper: 'true' },
      path: 'logs/{{date}}-workout.md',
      title: 'Workout {{date}}',
    })
  })

  it('parses a `schedules:` array of multiple fires', () => {
    const src = [
      '---',
      'schedules:',
      '  - cron: "0 * * * *"',
      '    vars: { type: "Upper Body" }',
      '    path: "logs/{{datetime}}-upper.md"',
      '    label: "Upper"',
      '  - cron: "20 * * * *"',
      '    vars: { type: "Lower Body" }',
      '    path: "logs/{{datetime}}-lower.md"',
      '  - cron: "40 * * * *"',
      '    vars: { type: "Cardio" }',
      '    path: "logs/{{datetime}}-cardio.md"',
      '---',
      'body',
    ].join('\n')
    const r = parseTemplateSource(src)
    expect(r.metadata.schedules).toHaveLength(3)
    expect(r.metadata.schedules[0]).toMatchObject({
      cron: '0 * * * *',
      vars: { type: 'Upper Body' },
      label: 'Upper',
    })
    expect(r.metadata.schedules[2].vars).toEqual({ type: 'Cardio' })
  })

  it('drops malformed entries from the schedules array', () => {
    const src = [
      '---',
      'schedules:',
      '  - cron: "0 6 * * *"',
      '  - vars: { type: "no cron" }',
      '---',
      'body',
    ].join('\n')
    const r = parseTemplateSource(src)
    expect(r.metadata.schedules).toHaveLength(1)
    expect(r.metadata.schedules[0].cron).toBe('0 6 * * *')
  })

  it('tolerates malformed YAML by treating file as bodyless-metadata', () => {
    const src = '---\nvars: [unterminated\n---\nbody'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars).toEqual([])
    // Body still falls back to the raw source so the engine still
    // has something to render.
    expect(r.body).toBe(src)
  })

  it('strict variant throws on malformed YAML', () => {
    const src = '---\nvars: [unterminated\n---\nbody'
    expect(() => parseTemplateSourceStrict(src)).toThrow(/malformed YAML/)
  })

  it('accepts CRLF line endings', () => {
    const src = '---\r\nvars:\r\n  - name: x\r\n---\r\nbody'
    const r = parseTemplateSource(src)
    expect(r.metadata.vars[0].name).toBe('x')
  })
})
