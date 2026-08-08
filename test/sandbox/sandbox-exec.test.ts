import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SandboxManager,
  executeSandboxedCommand,
  isSandboxPermissionError,
  startSandboxedCommand,
} from '../../src/index.js'
import { getPlatform } from '../../src/utils/platform.js'

const describeNodeRuntimeOnly =
  typeof Bun !== 'undefined' ? describe.skip : describe

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'srt-exec-test-'))
}

function createConfig(
  testDir: string,
  allowedDomains: string[] = ['example.com'],
) {
  return {
    network: {
      allowedDomains,
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [join(testDir, 'allow')],
      denyWrite: [],
    },
  }
}

function createProxyConnectCommand(
  testDir: string,
  targetHost: string,
): string {
  const scriptPath = join(testDir, 'proxy-connect.cjs')
  const script = `
const { connect } = require('node:net');
const proxyValue = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyValue === undefined || proxyValue === '') process.exit(10);
const proxy = new URL(proxyValue);
const socket = connect(Number(proxy.port), proxy.hostname, () => {
  socket.write('CONNECT ${targetHost}:443 HTTP/1.1\\r\\nHost: ${targetHost}:443\\r\\n\\r\\n');
});
let data = '';
socket.on('data', chunk => {
  data += chunk.toString();
  if (data.includes('\\r\\n')) {
    socket.destroy();
    process.exit(data.includes(' 200 ') ? 0 : 1);
  }
});
socket.on('error', () => process.exit(2));
socket.setTimeout(2000, () => {
  socket.destroy();
  process.exit(3);
});
`.trim()

  writeFileSync(scriptPath, script, 'utf8')
  return `node '${scriptPath}'`
}

describe('executeSandboxedCommand', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = createTestDir()
    mkdirSync(join(testDir, 'allow'), { recursive: true })
    await SandboxManager.reset()
  })

  afterEach(async () => {
    await SandboxManager.reset()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns a normal result for non-permission command failures', async () => {
    await SandboxManager.initialize(createConfig(testDir), undefined, true)

    const result = await executeSandboxedCommand('false')

    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
  })

  it('throws an fs.read permission error on macOS', async () => {
    if (getPlatform() !== 'macos') {
      return
    }

    const deniedPath = join(testDir, 'denied-read.txt')
    writeFileSync(deniedPath, 'secret\n', 'utf8')

    const config = createConfig(testDir)
    config.filesystem.denyRead = [deniedPath]
    await SandboxManager.initialize(config, undefined, true)

    const error = await executeSandboxedCommand(`cat '${deniedPath}'`).catch(
      error => error,
    )

    expect(isSandboxPermissionError(error)).toBe(true)
    if (!isSandboxPermissionError(error)) {
      return
    }

    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toMatchObject({
      kind: 'fs.read',
      detail: 'file-read-data',
    })
    expect(
      'path' in error.issues[0] &&
        error.issues[0].path.endsWith('/denied-read.txt'),
    ).toBe(true)
    expect(error.stderr.includes('<sandbox_violations>')).toBe(true)
  })

  it('throws an fs.write permission error on macOS', async () => {
    if (getPlatform() !== 'macos') {
      return
    }

    const deniedPath = join(testDir, 'denied-write.txt')
    writeFileSync(deniedPath, 'before\n', 'utf8')

    await SandboxManager.initialize(createConfig(testDir), undefined, true)

    const error = await executeSandboxedCommand(
      `echo blocked > '${deniedPath}'`,
    ).catch(error => error)

    expect(isSandboxPermissionError(error)).toBe(true)
    if (!isSandboxPermissionError(error)) {
      return
    }

    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toMatchObject({
      kind: 'fs.write',
      detail: 'file-write-data',
    })
    expect(
      'path' in error.issues[0] &&
        error.issues[0].path.endsWith('/denied-write.txt'),
    ).toBe(true)
  })

  it('returns a normal result when the shell command handles earlier failures itself', async () => {
    if (getPlatform() !== 'macos') {
      return
    }

    const deniedOne = join(testDir, 'denied-one.txt')
    const deniedTwo = join(testDir, 'denied-two.txt')
    writeFileSync(deniedOne, 'one\n', 'utf8')
    writeFileSync(deniedTwo, 'two\n', 'utf8')

    const config = createConfig(testDir)
    config.filesystem.denyRead = [deniedOne, deniedTwo]
    await SandboxManager.initialize(config, undefined, true)

    const result = await executeSandboxedCommand(
      `cat '${deniedOne}' >/dev/null; cat '${deniedTwo}' >/dev/null; true`,
    )

    expect(result.exitCode).toBe(0)
  })
})

describe('startSandboxedCommand', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = createTestDir()
    mkdirSync(join(testDir, 'allow'), { recursive: true })
    await SandboxManager.reset()
  })

  afterEach(async () => {
    await SandboxManager.reset()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('exposes output streams and returns the same settled result to every waiter', async () => {
    await SandboxManager.initialize(createConfig(testDir), undefined, true)

    const handle = await startSandboxedCommand(
      `printf 'first\\n'; sleep 0.05; printf 'second\\n'`,
    )
    const streamed: string[] = []
    handle.stdout?.on('data', chunk => streamed.push(chunk.toString()))

    const firstResult = await handle.wait()
    const secondResult = await handle.wait()

    expect(handle.pid).toBeNumber()
    expect(streamed.join('')).toBe('first\nsecond\n')
    expect(firstResult).toEqual({
      stdout: 'first\nsecond\n',
      stderr: '',
      exitCode: 0,
      signal: null,
    })
    expect(secondResult).toEqual(firstResult)
  })

  it('terminates a running command and settles its wait promise', async () => {
    await SandboxManager.initialize(createConfig(testDir), undefined, true)

    const handle = await startSandboxedCommand('while true; do sleep 1; done')
    await handle.terminate({ graceMs: 50 })
    const result = await handle.wait()

    expect(result.exitCode).toBeNull()
    expect(result.signal).not.toBeNull()
  })

  it('bounds captured wait output while leaving the live stream available', async () => {
    await SandboxManager.initialize(createConfig(testDir), undefined, true)

    const handle = await startSandboxedCommand(`printf '1234567890'`, {
      maxOutputChars: 4,
    })
    let streamed = ''
    handle.stdout?.on('data', chunk => {
      streamed += chunk.toString()
    })
    const result = await handle.wait()

    expect(streamed).toBe('1234567890')
    expect(result.stdout).toBe('7890')
  })
})

describeNodeRuntimeOnly('executeSandboxedCommand network permissions', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = createTestDir()
    mkdirSync(join(testDir, 'allow'), { recursive: true })
    await SandboxManager.reset()
  })

  afterEach(async () => {
    await SandboxManager.reset()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('throws a network permission error when the proxy blocks the request', async () => {
    await SandboxManager.initialize(createConfig(testDir, []), undefined, true)

    const error = await executeSandboxedCommand(
      createProxyConnectCommand(testDir, 'example.com'),
    ).catch(error => error)

    expect(isSandboxPermissionError(error)).toBe(true)
    if (!isSandboxPermissionError(error)) {
      return
    }

    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toMatchObject({
      kind: 'network',
      host: 'example.com',
      port: 443,
      detail: 'blocked-by-allowlist',
    })
  })

  it('returns a normal result when the shell handles a blocked network request', async () => {
    await SandboxManager.initialize(createConfig(testDir, []), undefined, true)

    const result = await executeSandboxedCommand(
      `${createProxyConnectCommand(testDir, 'example.com')} || true`,
    )

    expect(result.exitCode).toBe(0)
  })
})
