import { describe, expect, test } from 'bun:test'
import { SandboxViolationStore } from '../../src/sandbox/sandbox-violation-store.js'
import { encodeSandboxedCommand } from '../../src/sandbox/sandbox-utils.js'

describe('SandboxViolationStore', () => {
  test('reads command violations after an invocation cursor without clearing other runs', () => {
    const store = new SandboxViolationStore()
    const command = 'cat /private/secret'
    const event = (line: string) => ({
      line,
      encodedCommand: encodeSandboxedCommand(command),
      timestamp: new Date(),
    })

    store.addViolation(event('old'))
    const cursor = store.getTotalCount()
    store.addViolation(event('new'))
    store.addViolation({
      line: 'other command',
      encodedCommand: encodeSandboxedCommand('echo other'),
      timestamp: new Date(),
    })

    expect(store.getViolationsForCommandSince(command, cursor)).toEqual([
      expect.objectContaining({ line: 'new' }),
    ])
    expect(store.getViolationsForCommand(command)).toHaveLength(2)
  })
})
