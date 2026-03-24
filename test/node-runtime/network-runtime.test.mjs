import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import {
  SandboxManager,
  executeSandboxedCommand,
  isSandboxPermissionError,
} from '../../dist/index.js'

function createTestDir() {
  return mkdtempSync(join(tmpdir(), 'srt-node-runtime-'))
}

function createConfig(testDir, allowedDomains = ['example.com']) {
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

function createProxyConnectCommand(testDir, targetHost) {
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

function proxyRequest(proxyPort, targetHost) {
  return new Promise(resolve => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`,
      )
    })

    let data = ''
    socket.on('data', chunk => {
      data += chunk.toString()
      if (data.includes('\r\n')) {
        socket.destroy()
        const statusMatch = data.match(/HTTP\/1\.\d (\d+)/)
        const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0
        resolve({
          allowed: statusCode === 200,
          statusCode,
          response: data,
        })
      }
    })

    socket.on('error', err => {
      resolve({ allowed: false, response: err.message })
    })

    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve({ allowed: false, response: 'timeout' })
    })
  })
}

test('executeSandboxedCommand throws a network permission error on macOS', async () => {
  if (process.platform !== 'darwin') {
    return
  }

  const testDir = createTestDir()
  mkdirSync(join(testDir, 'allow'), { recursive: true })

  try {
    await SandboxManager.reset()
    await SandboxManager.initialize(createConfig(testDir, []), undefined, true)

    const error = await executeSandboxedCommand(
      createProxyConnectCommand(testDir, 'example.com'),
    ).catch(error => error)

    assert.equal(isSandboxPermissionError(error), true)
    assert.equal(error.issues.length, 1)
    assert.deepEqual(error.issues[0], {
      kind: 'network',
      host: 'example.com',
      port: 443,
      detail: 'blocked-by-allowlist',
      raw: 'example.com:443',
    })
  } finally {
    await SandboxManager.reset()
    rmSync(testDir, { recursive: true, force: true })
  }
})

test('executeSandboxedCommand returns success when the shell handles a blocked network request on macOS', async () => {
  if (process.platform !== 'darwin') {
    return
  }

  const testDir = createTestDir()
  mkdirSync(join(testDir, 'allow'), { recursive: true })

  try {
    await SandboxManager.reset()
    await SandboxManager.initialize(createConfig(testDir, []), undefined, true)

    const result = await executeSandboxedCommand(
      `${createProxyConnectCommand(testDir, 'example.com')} || true`,
    )

    assert.equal(result.exitCode, 0)
  } finally {
    await SandboxManager.reset()
    rmSync(testDir, { recursive: true, force: true })
  }
})

test('SandboxManager.updateConfig allow then block domain via proxy', async () => {
  try {
    await SandboxManager.reset()
    await SandboxManager.initialize({
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    })

    const proxyPort = SandboxManager.getProxyPort()
    assert.ok(proxyPort)

    const allowed = await proxyRequest(proxyPort, 'example.com')
    assert.equal(allowed.allowed, true)

    SandboxManager.updateConfig({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    })

    const blocked = await proxyRequest(proxyPort, 'example.com')
    assert.equal(blocked.allowed, false)
  } finally {
    await SandboxManager.reset()
  }
})

test('SandboxManager.updateConfig block then allow domain via proxy', async () => {
  try {
    await SandboxManager.reset()
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    })

    const proxyPort = SandboxManager.getProxyPort()
    assert.ok(proxyPort)

    const blocked = await proxyRequest(proxyPort, 'example.com')
    assert.equal(blocked.allowed, false)

    SandboxManager.updateConfig({
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    })

    const allowed = await proxyRequest(proxyPort, 'example.com')
    assert.equal(allowed.allowed, true)
  } finally {
    await SandboxManager.reset()
  }
})
