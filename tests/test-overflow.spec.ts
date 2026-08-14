import { describe, expect, it } from 'vitest'
import {
  commandCodeErrorMessage,
  normalizeCommandCodeErrorMessage,
  normalizeCommandCodeMessage,
  redactCommandCodeErrorText,
} from '../src/overflow.ts'

describe('redactCommandCodeErrorText', () => {
  it('redacts bearer tokens, api keys, and user tokens', () => {
    const input = 'Bearer sk-abcdef1234567890 failed; apiKey=user_abc12345; token: cc_zzz99999; ?api_key=user_secret'
    const out = redactCommandCodeErrorText(input)
    expect(out).not.toContain('sk-abcdef1234567890')
    expect(out).not.toContain('user_abc12345')
    expect(out).not.toContain('cc_zzz99999')
    expect(out).not.toContain('user_secret')
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('apiKey=[redacted]')
  })
})

describe('commandCodeErrorMessage', () => {
  it('extracts nested messages and statuses', () => {
    expect(commandCodeErrorMessage({ error: { message: 'boom' }, status: 400 })).toContain('boom')
    expect(commandCodeErrorMessage({ message: 'boom' })).toBe('boom')
    expect(commandCodeErrorMessage('plain')).toBe('plain')
    expect(commandCodeErrorMessage(undefined)).toBeUndefined()
  })

  it('redacts secrets inside extracted messages', () => {
    expect(commandCodeErrorMessage({ message: 'bad key user_abc12345' })).toBe('bad key [redacted]')
  })
})

describe('normalizeCommandCodeErrorMessage', () => {
  it('tags context overflow wording', () => {
    expect(normalizeCommandCodeErrorMessage('Context window exceeded. Reduce the prompt length')).toBe(
      'context_length_exceeded: Context window exceeded. Reduce the prompt length',
    )
    expect(normalizeCommandCodeErrorMessage('prompt too long')).toMatch(/^context_length_exceeded:/)
    expect(normalizeCommandCodeErrorMessage('input tokens limit reached')).toMatch(/^context_length_exceeded:/)
  })

  it('leaves non-overflow and already-tagged messages alone', () => {
    expect(normalizeCommandCodeErrorMessage('context_length_exceeded: already')).toBeUndefined()
    expect(normalizeCommandCodeErrorMessage('rate limit exceeded')).toBeUndefined()
    expect(normalizeCommandCodeErrorMessage('too many requests (429)')).toBeUndefined()
    expect(normalizeCommandCodeErrorMessage('service temporarily unavailable')).toBeUndefined()
    expect(normalizeCommandCodeErrorMessage('random failure')).toBeUndefined()
    expect(normalizeCommandCodeErrorMessage(undefined)).toBeUndefined()
  })
})

describe('normalizeCommandCodeMessage', () => {
  it('only touches assistant error messages for the commandcode provider', () => {
    const msg = { role: 'assistant', provider: 'commandcode', stopReason: 'error', errorMessage: 'Context window exceeded' }
    const out = normalizeCommandCodeMessage(msg)
    expect(out?.message.errorMessage).toMatch(/^context_length_exceeded:/)
    expect(normalizeCommandCodeMessage({ ...msg, provider: 'other' })).toBeUndefined()
    expect(normalizeCommandCodeMessage({ ...msg, stopReason: 'stop' })).toBeUndefined()
    expect(normalizeCommandCodeMessage({ ...msg, errorMessage: 'rate limited' })).toBeUndefined()
  })
})
