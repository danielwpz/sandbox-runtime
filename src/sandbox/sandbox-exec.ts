import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
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
const FORCE_KILL_WAIT_MS = 5_000
const TASKKILL_TIMEOUT_MS = 5_000

export interface SandboxExecOptions {
  binShell?: string
  customConfig?: Partial<SandboxRuntimeConfig>
  abortSignal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxOutputChars?: number
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface SandboxProcessHandle {
  pid: number | null
  stdout: Readable | null
  stderr: Readable | null
  wait(): Promise<SandboxExecResult>
  terminate(options?: { graceMs?: number }): Promise<void>
}

interface WrappedCommandHandle extends SandboxProcessHandle {
  wait(): Promise<SandboxExecResult>
}

export async function startSandboxedCommand(
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxProcessHandle> {
  if (options.abortSignal?.aborted) {
    throw createAbortError()
  }

  const violationCursor =
    SandboxManager.getSandboxViolationStore().getTotalCount()
  const scopedNetworkContext = await createScopedNetworkContext(
    options.customConfig,
  )
  const scopedCustomConfig = withScopedNetworkPorts(
    options.customConfig,
    scopedNetworkContext,
  )

  let wrappedHandle: WrappedCommandHandle
  try {
    const wrappedCommand = await SandboxManager.wrapWithSandbox(
      command,
      options.binShell,
      scopedCustomConfig,
      options.abortSignal,
    )
    wrappedHandle = startWrappedCommand(wrappedCommand, options)
  } catch (error) {
    await scopedNetworkContext?.close()
    throw error
  }

  const waitPromise = wrappedHandle
    .wait()
    .then(async result => {
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

      const fsIssues = await pollMacOsPermissionIssues(command, violationCursor)
      if (fsIssues.length === 0) {
        return result
      }

      throw new SandboxPermissionError({
        issues: fsIssues,
        stdout: result.stdout,
        stderr: annotateStderrWithViolations(
          result.stderr,
          SandboxManager.getSandboxViolationStore().getViolationsForCommandSince(
            command,
            violationCursor,
          ),
        ),
        exitCode: result.exitCode,
        signal: result.signal,
      })
    })
    .finally(async () => {
      await scopedNetworkContext?.close()
    })

  // The process starts before callers are required to await it. Attach a
  // rejection handler immediately so a late wait() call cannot cause an
  // unhandled rejection in the meantime.
  void waitPromise.catch(() => {})

  return {
    pid: wrappedHandle.pid,
    stdout: wrappedHandle.stdout,
    stderr: wrappedHandle.stderr,
    wait: () => waitPromise,
    terminate: options => wrappedHandle.terminate(options),
  }
}

export async function executeSandboxedCommand(
  command: string,
  options: SandboxExecOptions = {},
): Promise<SandboxExecResult> {
  const handle = await startSandboxedCommand(command, options)
  return handle.wait()
}

function startWrappedCommand(
  wrappedCommand: string,
  options: SandboxExecOptions,
): WrappedCommandHandle {
  if (options.abortSignal?.aborted) {
    throw createAbortError()
  }

  const child = spawn(wrappedCommand, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  })

  let childClosed = false
  const childClosePromise = new Promise<void>(resolve => {
    child.once('close', () => {
      childClosed = true
      resolve()
    })
  })
  const waitForClose = async (timeoutMs: number): Promise<boolean> => {
    if (childClosed) {
      return true
    }

    let timeout: ReturnType<typeof setTimeout> | null = null
    const result = await Promise.race([
      childClosePromise.then(() => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    return result
  }

  let terminationPromise: Promise<void> | null = null
  const waitPromise = new Promise<SandboxExecResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborting = false

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
      aborting = true
      void terminateCommandTree(child, 0, waitForClose).finally(() =>
        finish(() => {
          reject(createAbortError())
        }),
      )
    }

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true })
      if (options.abortSignal.aborted) {
        onAbort()
        return
      }
    }

    child.stdout.on('data', chunk => {
      stdout = appendCapturedOutput(
        stdout,
        chunk.toString(),
        options.maxOutputChars,
      )
    })
    child.stderr.on('data', chunk => {
      stderr = appendCapturedOutput(
        stderr,
        chunk.toString(),
        options.maxOutputChars,
      )
    })
    child.on('error', error => {
      finish(() => {
        reject(error)
      })
    })
    child.on('close', (code, signal) => {
      if (aborting) {
        return
      }
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

  void waitPromise.catch(() => {})

  return {
    pid: child.pid ?? null,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => waitPromise,
    terminate(terminateOptions = {}): Promise<void> {
      terminationPromise ??= terminateCommandTree(
        child,
        Math.max(0, terminateOptions.graceMs ?? 5_000),
        waitForClose,
      )
      return terminationPromise
    },
  }
}

function appendCapturedOutput(
  current: string,
  chunk: string,
  maxOutputChars: number | undefined,
): string {
  if (maxOutputChars === undefined) {
    return current + chunk
  }
  const maxChars = Math.max(0, Math.floor(maxOutputChars))
  if (maxChars === 0) {
    return ''
  }
  const combined = current + chunk
  return combined.length <= maxChars ? combined : combined.slice(-maxChars)
}

async function terminateCommandTree(
  child: ChildProcess,
  graceMs: number,
  waitForClose: (timeoutMs: number) => Promise<boolean>,
): Promise<void> {
  if (child.pid === undefined || child.pid === null) {
    return
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  if (process.platform === 'win32') {
    if (graceMs > 0) {
      const requested = await runTaskkill(child.pid, false)
      if (requested && (await waitForClose(graceMs))) {
        return
      }
    }
    const killed = await runTaskkill(child.pid, true)
    if (!killed) {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already have settled.
      }
    }
    if (!(await waitForClose(FORCE_KILL_WAIT_MS))) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best-effort fallback when taskkill does not settle the parent handle.
      }
    }
    return
  } else {
    try {
      process.kill(-child.pid, graceMs > 0 ? 'SIGTERM' : 'SIGKILL')
    } catch {
      try {
        child.kill(graceMs > 0 ? 'SIGTERM' : 'SIGKILL')
      } catch {
        return
      }
    }

    if (graceMs > 0) {
      await waitForClose(graceMs)
      if (!isPosixProcessGroupAlive(child.pid)) {
        return
      }
    }

    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore already-dead processes.
      }
    }
    await waitForClose(FORCE_KILL_WAIT_MS)
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const args = [...(force ? ['/F'] : []), '/T', '/PID', String(pid)]
      const killer = spawn('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      })
      let settled = false
      const finish = (killed: boolean) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        killer.removeAllListeners()
        resolve(killed)
      }
      const timeout = setTimeout(() => {
        try {
          killer.kill('SIGKILL')
        } catch {
          // Best-effort cleanup if taskkill itself gets stuck.
        }
        finish(false)
      }, TASKKILL_TIMEOUT_MS)
      killer.once('error', () => finish(false))
      killer.once('close', code => finish(code === 0))
    } catch {
      resolve(false)
    }
  })
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
  afterSequence: number,
): Promise<SandboxPermissionIssue[]> {
  const startedAt = Date.now()
  let lastIssues: SandboxPermissionIssue[] = []

  while (Date.now() - startedAt <= MACOS_VIOLATION_TIMEOUT_MS) {
    lastIssues = getMacOsPermissionIssues(command, afterSequence)
    if (lastIssues.length > 0) {
      return lastIssues
    }
    await sleep(MACOS_VIOLATION_POLL_INTERVAL_MS)
  }

  return lastIssues
}

function getMacOsPermissionIssues(
  command: string,
  afterSequence: number,
): SandboxPermissionIssue[] {
  const violations =
    SandboxManager.getSandboxViolationStore().getViolationsForCommandSince(
      command,
      afterSequence,
    )
  return violations
    .map(parseMacOsViolation)
    .filter((issue): issue is SandboxPermissionIssue => issue !== null)
}

function annotateStderrWithViolations(
  stderr: string,
  violations: SandboxViolationEvent[],
): string {
  if (violations.length === 0) {
    return stderr
  }

  const separator = stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''
  return `${stderr}${separator}<sandbox_violations>\n${violations
    .map(violation => violation.line)
    .join('\n')}\n</sandbox_violations>`
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
      ...(customConfig?.filesystem?.writeMode !== undefined
        ? { writeMode: customConfig.filesystem.writeMode }
        : baseConfig?.filesystem.writeMode !== undefined
          ? { writeMode: baseConfig.filesystem.writeMode }
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
