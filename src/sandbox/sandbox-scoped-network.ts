import type { Server } from 'node:net'
import { createHttpProxyServer } from './http-proxy.js'
import { createSocksProxyServer } from './socks-proxy.js'
import type { SocksProxyWrapper } from './socks-proxy.js'
import type { SandboxRuntimeConfig } from './sandbox-config.js'
import type { SandboxNetworkBlockEvent } from './sandbox-network-event-store.js'
import { logForDebugging } from '../utils/debug.js'

export interface ScopedNetworkProxyContext {
  httpProxyPort: number
  socksProxyPort: number
  getBlockedEvents(): SandboxNetworkBlockEvent[]
  close(): Promise<void>
}

export async function createScopedNetworkProxyContext(
  runtimeConfig: SandboxRuntimeConfig,
): Promise<ScopedNetworkProxyContext> {
  const blockedEvents: SandboxNetworkBlockEvent[] = []

  const httpProxyServer = createHttpProxyServer({
    filter: (port: number, host: string) =>
      filterNetworkRequest(runtimeConfig, port, host),
    onDeniedRequest: (port: number, host: string) => {
      blockedEvents.push({
        host,
        port,
        detail: 'blocked-by-allowlist',
        timestamp: new Date(),
      })
    },
    getMitmSocketPath: (host: string) => getMitmSocketPath(runtimeConfig, host),
  })

  const socksProxyServer = createSocksProxyServer({
    filter: (port: number, host: string) =>
      filterNetworkRequest(runtimeConfig, port, host),
    onDeniedRequest: (port: number, host: string) => {
      blockedEvents.push({
        host,
        port,
        detail: 'blocked-by-allowlist',
        timestamp: new Date(),
      })
    },
  })

  try {
    const httpProxyPort = await listenHttpProxyServer(httpProxyServer)
    const socksProxyPort = await listenSocksProxyServer(socksProxyServer)

    return {
      httpProxyPort,
      socksProxyPort,
      getBlockedEvents(): SandboxNetworkBlockEvent[] {
        return [...blockedEvents]
      },
      async close(): Promise<void> {
        await Promise.all([
          closeHttpProxyServer(httpProxyServer),
          closeSocksProxyServer(socksProxyServer),
        ])
      },
    }
  } catch (error) {
    await Promise.all([
      closeHttpProxyServer(httpProxyServer),
      closeSocksProxyServer(socksProxyServer),
    ])
    throw error
  }
}

async function filterNetworkRequest(
  runtimeConfig: SandboxRuntimeConfig,
  port: number,
  host: string,
): Promise<boolean> {
  for (const deniedDomain of runtimeConfig.network.deniedDomains) {
    if (matchesDomainPattern(host, deniedDomain)) {
      logForDebugging(`Denied by scoped config rule: ${host}:${port}`)
      return false
    }
  }

  for (const allowedDomain of runtimeConfig.network.allowedDomains) {
    if (matchesDomainPattern(host, allowedDomain)) {
      logForDebugging(`Allowed by scoped config rule: ${host}:${port}`)
      return true
    }
  }

  logForDebugging(`No scoped config rule matched: ${host}:${port}`)
  return false
}

function getMitmSocketPath(
  runtimeConfig: SandboxRuntimeConfig,
  host: string,
): string | undefined {
  if (!runtimeConfig.network.mitmProxy) {
    return undefined
  }

  const { socketPath, domains } = runtimeConfig.network.mitmProxy
  for (const pattern of domains) {
    if (matchesDomainPattern(host, pattern)) {
      return socketPath
    }
  }

  return undefined
}

function matchesDomainPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2)
    return hostname.toLowerCase().endsWith(`.${baseDomain.toLowerCase()}`)
  }

  return hostname.toLowerCase() === pattern.toLowerCase()
}

function listenHttpProxyServer(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to get scoped HTTP proxy address'))
        return
      }

      server.unref()
      resolve(address.port)
    })
    server.listen(0, '127.0.0.1')
  })
}

function listenSocksProxyServer(server: SocksProxyWrapper): Promise<number> {
  return server.listen(0, '127.0.0.1').then((port: number) => {
    server.unref()
    return port
  })
}

function closeHttpProxyServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => {
      resolve()
    })
  })
}

function closeSocksProxyServer(server: SocksProxyWrapper): Promise<void> {
  return server.close().catch((error: Error) => {
    logForDebugging(`Scoped SOCKS proxy close failed: ${error.message}`, {
      level: 'error',
    })
  })
}
