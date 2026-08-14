import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertTextOnlyMessages,
  getApiKey,
  mapFinishReason,
  messagesToCC,
  parseStreamEventLine,
  recordOrEmpty,
  systemPromptToText,
  toolsToJson,
} from '../src/converters.ts'
import { toJsonSchema } from '../src/json-schema.ts'

describe('messagesToCC', () => {
  it('converts user/assistant/tool messages with paired tool calls', () => {
    const out = messagesToCC([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'text', text: 'let me check' },
        { type: 'toolCall', id: 'call-1', name: 'fs_read', arguments: { path: 'a.txt' } },
      ] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'fs_read', content: [{ type: 'text', text: 'file body' }] },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'fs_read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'fs_read',
            output: { type: 'text', value: 'file body' },
          },
        ],
      },
    ])
  })

  it('drops unpaired tool calls and results', () => {
    const out = messagesToCC([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-9', name: 'x', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'orphan', toolName: 'y', content: 'no call' },
    ])
    expect(out).toEqual([])
  })

  it('renders tool errors as error-text output', () => {
    const out = messagesToCC([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 't', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'c', toolName: 't', isError: true, content: [{ type: 'text', text: 'boom' }] },
    ])
    expect(out[1]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', output: { type: 'error-text', value: 'boom' } }],
    })
  })

  it('rejects images for text-only models before streaming', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    ]
    expect(() => messagesToCC(messages)).toThrow(/does not support image content/)
    expect(() => assertTextOnlyMessages(messages)).toThrow(/does not support image content/)
  })

  it('converts images to data-URL wire format when allowed', () => {
    const out = messagesToCC(
      [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'what is this?' }] }],
      { allowImages: true },
    )
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })
})

describe('parseStreamEventLine', () => {
  it('parses data: JSON lines and skips comments/DONE', () => {
    expect(parseStreamEventLine('data: {"type":"text-delta","text":"hi"}')).toEqual({ type: 'text-delta', text: 'hi' })
    expect(parseStreamEventLine('{"type":"finish"}')).toEqual({ type: 'finish' })
    expect(parseStreamEventLine(': comment')).toBeUndefined()
    expect(parseStreamEventLine('event: text-delta')).toBeUndefined()
    expect(parseStreamEventLine('data: [DONE]')).toBeUndefined()
    expect(parseStreamEventLine('not json')).toBeUndefined()
    expect(parseStreamEventLine('')).toBeUndefined()
  })
})

describe('mapFinishReason', () => {
  it('maps tool-calls and length variants', () => {
    expect(mapFinishReason('tool-calls')).toBe('toolUse')
    expect(mapFinishReason('length')).toBe('length')
    expect(mapFinishReason('max_tokens')).toBe('length')
    expect(mapFinishReason('max-tokens')).toBe('length')
    expect(mapFinishReason('max_output_tokens')).toBe('length')
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('whatever')).toBe('stop')
  })
})

describe('systemPromptToText', () => {
  it('flattens string/array/object prompts', () => {
    expect(systemPromptToText('plain')).toBe('plain')
    expect(systemPromptToText(['a', 'b'])).toBe('a\n\nb')
    expect(systemPromptToText([{ type: 'text', text: 'x' }, 'y'])).toBe('x\n\ny')
    expect(systemPromptToText(undefined)).toBe('')
  })
})

describe('toolsToJson / toJsonSchema', () => {
  it('wraps tools with input_schema', () => {
    const out = toolsToJson([{ name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }])
    expect(out).toEqual([{ type: 'function', name: 'f', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }])
  })

  it('converts legacy optional/union schemas', () => {
    const converted = toJsonSchema({
      kind: 'object',
      properties: {
        a: { kind: 'string' },
        b: { kind: 'optional', wrapped: { kind: 'number' } },
        c: { kind: 'union', variants: [{ kind: 'string' }, { kind: 'null' }] },
      },
    })
    expect(converted).toMatchObject({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['a', 'c'],
    })
  })

  it('handles nullable', () => {
    expect(toJsonSchema({ kind: 'string', nullable: true })).toEqual({ type: ['string', 'null'] })
  })
})

describe('getApiKey auth-file fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-auth-'))

  function withHome(name: string, files: Record<string, string>): () => string {
    const home = join(dir, name)
    for (const [rel, content] of Object.entries(files)) {
      const target = join(home, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
    }
    return () => home
  }

  it('reads CLI api shape from .commandcode/auth.json', () => {
    const homeDir = withHome('cli', { '.commandcode/auth.json': JSON.stringify({ 'command-code': { type: 'api', key: 'user_cli_key' } }) })
    expect(getApiKey({ env: {}, homeDir })).toBe('user_cli_key')
  })

  it('reads pi oauth shape from .pi/agent/auth.json', () => {
    const homeDir = withHome('pi', { '.pi/agent/auth.json': JSON.stringify({ commandcode: { type: 'oauth', access: 'user_pi_key' } }) })
    expect(getApiKey({ env: {}, homeDir })).toBe('user_pi_key')
  })

  it('reads legacy apiKey shape from .omp/agent/auth.json', () => {
    const homeDir = withHome('omp', { '.omp/agent/auth.json': JSON.stringify({ apiKey: 'user_omp_key' }) })
    expect(getApiKey({ env: {}, homeDir })).toBe('user_omp_key')
  })

  it('prefers the environment over auth files', () => {
    const homeDir = withHome('env', { '.commandcode/auth.json': JSON.stringify({ apiKey: 'user_file_key' }) })
    expect(getApiKey({ env: { COMMANDCODE_API_KEY: 'user_env_key' }, homeDir })).toBe('user_env_key')
  })

  it('ignores malformed files and falls through', () => {
    const homeDir = withHome('malformed', {
      '.commandcode/auth.json': 'not json',
      '.omp/agent/auth.json': JSON.stringify({ apiKey: 'user_omp_key' }),
    })
    expect(getApiKey({ env: {}, homeDir })).toBe('user_omp_key')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})

describe('recordOrEmpty', () => {
  it('parses JSON strings and returns {} otherwise', () => {
    expect(recordOrEmpty('{"a":1}')).toEqual({ a: 1 })
    expect(recordOrEmpty('broken')).toEqual({})
    expect(recordOrEmpty({ b: 2 })).toEqual({ b: 2 })
    expect(recordOrEmpty(42)).toEqual({})
  })
})
