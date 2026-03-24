import { spawn, type ChildProcess } from 'node:child_process'
import type { SandboxRuntimeConfig } from './sandbox-config.js'
import type { SandboxViolationEvent } from './macos-sandbox-utils.js'
import { SandboxManager } from './sandbox-manager.js'
import {
  SandboxPermissionError,
  type SandboxPermissionIssue,
} from './sandbox-permission-error.js'
import { createScopedNetworkProxyContext } from './sandbox-scoped-network.js'
import { getPlatform } from '../utils/platform.js'

const MACOS_VIOLATION_POLL_INTERVAL_MS = 50
const MACOS_VIOLATION_TIMEOUT_MS = 500

export interface SandboxExecOptions {
  binShell?: string
  customConfig?: Partial<SandboxRuntimeConfig>
  abortSignal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export async function executeSandboxedCommand(
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  SandboxManager.getSandboxViolationStore().clear()

  const scopedNetworkContext = await createScopedNetworkContext(
    options.customConfig,
  )
  const scopedCustomConfig = withScopedNetworkPorts(
    options.customConfig,
    scopedNetworkContext,
  )

  try {
    const wrappedCommand = await SandboxManager.wrapWithSandbox(
      command,
      options.binShell,
      scopedCustomConfig,
      options.abortSignal,
    )

    const result = await runWrappedCommand(wrappedCommand, options)

    if (result.exitCode === 0) {
      return result
    }

    const networkIssues = getScopedNetworkIssues(scopedNetworkContext)
    if (networkIssues.length > 0) {
      throw new SandboxPermissionError({
        issues: networkIssues,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
      })
    }

    if (getPlatform() !== 'macos') {
      return result
    }

    const fsIssues = await pollMacOsPermissionIssues(command)
    if (fsIssues.length === 0) {
      return result
    }

    throw new SandboxPermissionError({
      issues: fsIssues,
      stdout: result.stdout,
      stderr: SandboxManager.annotateStderrWithSandboxFailures(
        command,
        result.stderr,
      ),
      exitCode: result.exitCode,
      signal: result.signal,
    })
  } finally {
    await scopedNetworkContext?.close()
  }
}

async function runWrappedCommand(
  wrappedCommand: string,
  options: SandboxExecOptions,
): Promise<SandboxExecResult> {
  return new Promise((resolve, reject) => {
    if (options.abortSignal?.aborted) {
      reject(createAbortError())
      return
    }

    const child = spawn(wrappedCommand, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', onAbort)
      }
      callback()
    }

    const onAbort = () => {
      killCommandTree(child)
      finish(() => {
        reject(createAbortError())
      })
    }

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', error => {
      finish(() => {
        reject(error)
      })
    })
    child.on('close', (code, signal) => {
      finish(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal,
        })
      })
    })
  })
}

function killCommandTree(child: ChildProcess): void {
  if (child.pid === undefined || child.pid === null) {
    return
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn(
        'taskkill',
        ['/F', '/T', '/PID', String(child.pid)],
        {
          stdio: 'ignore',
          detached: true,
        },
      )
      killer.unref()
      return
    } catch {
      // Fall back to killing the immediate process.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to killing the immediate process.
    }
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // Ignore already-dead processes.
  }
}

function createAbortError(): Error {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  })
}

function getScopedNetworkIssues(
  scopedNetworkContext:
    | Awaited<ReturnType<typeof createScopedNetworkProxyContext>>
    | undefined,
): SandboxPermissionIssue[] {
  if (!scopedNetworkContext) {
    return []
  }

  return scopedNetworkContext.getBlockedEvents().map(event => ({
    kind: 'network',
    host: event.host,
    port: event.port,
    detail: event.detail,
    raw: `${event.host}:${event.port}`,
  }))
}

async function pollMacOsPermissionIssues(
  command: string,
): Promise<SandboxPermissionIssue[]> {
  const startedAt = Date.now()
  let lastIssues: SandboxPermissionIssue[] = []

  while (Date.now() - startedAt <= MACOS_VIOLATION_TIMEOUT_MS) {
    lastIssues = getMacOsPermissionIssues(command)
    if (lastIssues.length > 0) {
      return lastIssues
    }
    await sleep(MACOS_VIOLATION_POLL_INTERVAL_MS)
  }

  return lastIssues
}

function getMacOsPermissionIssues(command: string): SandboxPermissionIssue[] {
  const violations =
    SandboxManager.getSandboxViolationStore().getViolationsForCommand(command)
  return violations
    .map(parseMacOsViolation)
    .filter((issue): issue is SandboxPermissionIssue => issue !== null)
}

function parseMacOsViolation(
  violation: SandboxViolationEvent,
): SandboxPermissionIssue | null {
  const match = violation.line.match(
    /\b(?<operation>file-(?:read|write)[a-z-]*)\s+(?<path>\/.+)$/i,
  )

  if (!match?.groups?.operation || !match.groups.path) {
    return null
  }

  const operation = match.groups.operation
  const path = match.groups.path

  if (operation.startsWith('file-read')) {
    return {
      kind: 'fs.read',
      path,
      detail: operation,
      raw: violation.line,
    }
  }

  if (operation.startsWith('file-write')) {
    return {
      kind: 'fs.write',
      path,
      detail: operation,
      raw: violation.line,
    }
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function createScopedNetworkContext(
  customConfig?: Partial<SandboxRuntimeConfig>,
) {
  if (getPlatform() !== 'macos') {
    return undefined
  }

  const effectiveConfig = resolveEffectiveConfig(customConfig)
  if (!needsScopedNetworkProxy(effectiveConfig)) {
    return undefined
  }

  return createScopedNetworkProxyContext(effectiveConfig)
}

function resolveEffectiveConfig(
  customConfig?: Partial<SandboxRuntimeConfig>,
): SandboxRuntimeConfig | undefined {
  const baseConfig = SandboxManager.getConfig()
  if (!baseConfig && !customConfig) {
    return undefined
  }

  return {
    network: {
      ...(customConfig?.network?.mode !== undefined
        ? { mode: customConfig.network.mode }
        : baseConfig?.network.mode !== undefined
          ? { mode: baseConfig.network.mode }
          : {}),
      allowedDomains:
        customConfig?.network?.allowedDomains ??
        baseConfig?.network.allowedDomains ??
        [],
      deniedDomains:
        customConfig?.network?.deniedDomains ??
        baseConfig?.network.deniedDomains ??
        [],
      ...(customConfig?.network?.mitmProxy !== undefined
        ? { mitmProxy: customConfig.network.mitmProxy }
        : baseConfig?.network.mitmProxy !== undefined
          ? { mitmProxy: baseConfig.network.mitmProxy }
          : {}),
      ...(customConfig?.network?.allowUnixSockets !== undefined
        ? { allowUnixSockets: customConfig.network.allowUnixSockets }
        : baseConfig?.network.allowUnixSockets !== undefined
          ? { allowUnixSockets: baseConfig.network.allowUnixSockets }
          : {}),
      ...(customConfig?.network?.allowAllUnixSockets !== undefined
        ? { allowAllUnixSockets: customConfig.network.allowAllUnixSockets }
        : baseConfig?.network.allowAllUnixSockets !== undefined
          ? { allowAllUnixSockets: baseConfig.network.allowAllUnixSockets }
          : {}),
      ...(customConfig?.network?.allowLocalBinding !== undefined
        ? { allowLocalBinding: customConfig.network.allowLocalBinding }
        : baseConfig?.network.allowLocalBinding !== undefined
          ? { allowLocalBinding: baseConfig.network.allowLocalBinding }
          : {}),
      ...(customConfig?.network?.httpProxyPort !== undefined
        ? { httpProxyPort: customConfig.network.httpProxyPort }
        : baseConfig?.network.httpProxyPort !== undefined
          ? { httpProxyPort: baseConfig.network.httpProxyPort }
          : {}),
      ...(customConfig?.network?.socksProxyPort !== undefined
        ? { socksProxyPort: customConfig.network.socksProxyPort }
        : baseConfig?.network.socksProxyPort !== undefined
          ? { socksProxyPort: baseConfig.network.socksProxyPort }
          : {}),
    },
    filesystem: {
      ...(customConfig?.filesystem?.readMode !== undefined
        ? { readMode: customConfig.filesystem.readMode }
        : baseConfig?.filesystem.readMode !== undefined
          ? { readMode: baseConfig.filesystem.readMode }
          : {}),
      denyRead:
        customConfig?.filesystem?.denyRead ??
        baseConfig?.filesystem.denyRead ??
        [],
      allowWrite:
        customConfig?.filesystem?.allowWrite ??
        baseConfig?.filesystem.allowWrite ??
        [],
      denyWrite:
        customConfig?.filesystem?.denyWrite ??
        baseConfig?.filesystem.denyWrite ??
        [],
      ...(customConfig?.filesystem?.allowRead !== undefined
        ? { allowRead: customConfig.filesystem.allowRead }
        : baseConfig?.filesystem.allowRead !== undefined
          ? { allowRead: baseConfig.filesystem.allowRead }
          : {}),
      ...(customConfig?.filesystem?.allowGitConfig !== undefined
        ? { allowGitConfig: customConfig.filesystem.allowGitConfig }
        : baseConfig?.filesystem.allowGitConfig !== undefined
          ? { allowGitConfig: baseConfig.filesystem.allowGitConfig }
          : {}),
    },
    ...(customConfig?.ignoreViolations !== undefined
      ? { ignoreViolations: customConfig.ignoreViolations }
      : baseConfig?.ignoreViolations !== undefined
        ? { ignoreViolations: baseConfig.ignoreViolations }
        : {}),
    ...(customConfig?.allowPty !== undefined
      ? { allowPty: customConfig.allowPty }
      : baseConfig?.allowPty !== undefined
        ? { allowPty: baseConfig.allowPty }
        : {}),
    ...(customConfig?.enableWeakerNestedSandbox !== undefined
      ? { enableWeakerNestedSandbox: customConfig.enableWeakerNestedSandbox }
      : baseConfig?.enableWeakerNestedSandbox !== undefined
        ? { enableWeakerNestedSandbox: baseConfig.enableWeakerNestedSandbox }
        : {}),
    ...(customConfig?.enableWeakerNetworkIsolation !== undefined
      ? {
          enableWeakerNetworkIsolation:
            customConfig.enableWeakerNetworkIsolation,
        }
      : baseConfig?.enableWeakerNetworkIsolation !== undefined
        ? {
            enableWeakerNetworkIsolation:
              baseConfig.enableWeakerNetworkIsolation,
          }
        : {}),
    ...(customConfig?.ripgrep !== undefined
      ? { ripgrep: customConfig.ripgrep }
      : baseConfig?.ripgrep !== undefined
        ? { ripgrep: baseConfig.ripgrep }
        : {}),
    ...(customConfig?.mandatoryDenySearchDepth !== undefined
      ? { mandatoryDenySearchDepth: customConfig.mandatoryDenySearchDepth }
      : baseConfig?.mandatoryDenySearchDepth !== undefined
        ? { mandatoryDenySearchDepth: baseConfig.mandatoryDenySearchDepth }
        : {}),
    ...(customConfig?.seccomp !== undefined
      ? { seccomp: customConfig.seccomp }
      : baseConfig?.seccomp !== undefined
        ? { seccomp: baseConfig.seccomp }
        : {}),
  }
}

function needsScopedNetworkProxy(
  effectiveConfig: SandboxRuntimeConfig | undefined,
): effectiveConfig is SandboxRuntimeConfig {
  if (!effectiveConfig) {
    return false
  }

  if (
    effectiveConfig.network.httpProxyPort !== undefined ||
    effectiveConfig.network.socksProxyPort !== undefined
  ) {
    return false
  }

  if ((effectiveConfig.network.mode ?? 'allow_only') === 'deny_only') {
    return effectiveConfig.network.deniedDomains.length > 0
  }

  return effectiveConfig.network.allowedDomains !== undefined
}

function withScopedNetworkPorts(
  customConfig: Partial<SandboxRuntimeConfig> | undefined,
  scopedNetworkContext:
    | Awaited<ReturnType<typeof createScopedNetworkProxyContext>>
    | undefined,
): Partial<SandboxRuntimeConfig> | undefined {
  if (!scopedNetworkContext) {
    return customConfig
  }

  const effectiveNetworkConfig = resolveEffectiveConfig(customConfig)?.network

  return {
    ...customConfig,
    network: {
      ...(effectiveNetworkConfig?.mode !== undefined
        ? { mode: effectiveNetworkConfig.mode }
        : {}),
      allowedDomains: effectiveNetworkConfig?.allowedDomains ?? [],
      deniedDomains: effectiveNetworkConfig?.deniedDomains ?? [],
      ...(effectiveNetworkConfig?.allowUnixSockets !== undefined
        ? { allowUnixSockets: effectiveNetworkConfig.allowUnixSockets }
        : {}),
      ...(effectiveNetworkConfig?.allowAllUnixSockets !== undefined
        ? { allowAllUnixSockets: effectiveNetworkConfig.allowAllUnixSockets }
        : {}),
      ...(effectiveNetworkConfig?.allowLocalBinding !== undefined
        ? { allowLocalBinding: effectiveNetworkConfig.allowLocalBinding }
        : {}),
      ...(effectiveNetworkConfig?.mitmProxy !== undefined
        ? { mitmProxy: effectiveNetworkConfig.mitmProxy }
        : {}),
      httpProxyPort: scopedNetworkContext.httpProxyPort,
      socksProxyPort: scopedNetworkContext.socksProxyPort,
    },
    ...(customConfig?.filesystem !== undefined
      ? { filesystem: customConfig.filesystem }
      : {}),
  }
}
