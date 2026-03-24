export type SandboxPermissionIssue =
  | {
      kind: 'fs.read'
      path: string
      detail?: string
      raw?: string
    }
  | {
      kind: 'fs.write'
      path: string
      detail?: string
      raw?: string
    }
  | {
      kind: 'network'
      host: string
      port?: number
      detail?: string
      raw?: string
    }

export interface SandboxPermissionErrorOptions {
  issues: SandboxPermissionIssue[]
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

function buildMessage(issues: SandboxPermissionIssue[]): string {
  if (issues.length === 0) {
    return 'Sandbox blocked the command'
  }

  if (issues.length === 1) {
    const issue = issues[0]
    switch (issue.kind) {
      case 'fs.read':
        return `Sandbox blocked file read: ${issue.path}`
      case 'fs.write':
        return `Sandbox blocked file write: ${issue.path}`
      case 'network':
        return `Sandbox blocked network access: ${issue.host}${issue.port ? `:${issue.port}` : ''}`
    }
  }

  return `Sandbox blocked ${issues.length} permission-sensitive operations`
}

export class SandboxPermissionError extends Error {
  readonly issues: SandboxPermissionIssue[]
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(options: SandboxPermissionErrorOptions) {
    super(buildMessage(options.issues))
    this.name = 'SandboxPermissionError'
    this.issues = options.issues
    this.stdout = options.stdout ?? ''
    this.stderr = options.stderr ?? ''
    this.exitCode = options.exitCode ?? null
    this.signal = options.signal ?? null
  }
}

export function isSandboxPermissionError(
  error: unknown,
): error is SandboxPermissionError {
  return error instanceof SandboxPermissionError
}
