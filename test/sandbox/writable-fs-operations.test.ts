import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlatform } from '../../src/utils/platform.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import { wrapCommandWithSandboxLinux } from '../../src/sandbox/linux-sandbox-utils.js'
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
} from '../../src/sandbox/sandbox-schemas.js'

function skipIfUnsupportedPlatform(): boolean {
  const platform = getPlatform()
  return platform !== 'linux' && platform !== 'macos'
}

async function runSandboxedCommand(input: {
  cwd: string
  command: string
  readConfig: FsReadRestrictionConfig | undefined
  writeConfig: FsWriteRestrictionConfig | undefined
  homeDir?: string
}): Promise<ReturnType<typeof spawnSync>> {
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME
  process.chdir(input.cwd)
  if (input.homeDir !== undefined) {
    process.env.HOME = input.homeDir
  }

  try {
    const wrappedCommand =
      getPlatform() === 'macos'
        ? wrapCommandWithSandboxMacOS({
            command: input.command,
            needsNetworkRestriction: false,
            readConfig: input.readConfig,
            writeConfig: input.writeConfig,
          })
        : await wrapCommandWithSandboxLinux({
            command: input.command,
            needsNetworkRestriction: false,
            readConfig: input.readConfig,
            writeConfig: input.writeConfig,
          })

    return spawnSync(wrappedCommand, {
      shell: true,
      encoding: 'utf8',
      cwd: input.cwd,
      timeout: 10000,
    })
  } finally {
    process.env.HOME = originalHome
    process.chdir(originalCwd)
  }
}

interface FsOperationCase {
  name: string
  command: string
  assert(rootDir: string): void
}

const BASIC_FS_OPERATION_CASES: FsOperationCase[] = [
  {
    name: 'reads existing files',
    command: "cat 'safe-root.txt'",
    assert(rootDir) {
      expect(readFileSync(join(rootDir, 'safe-root.txt'), 'utf8')).toContain(
        'ROOT_ORIGINAL',
      )
    },
  },
  {
    name: 'creates new files',
    command: "echo 'CREATED_CONTENT' > 'created.txt'",
    assert(rootDir) {
      expect(readFileSync(join(rootDir, 'created.txt'), 'utf8').trim()).toBe(
        'CREATED_CONTENT',
      )
    },
  },
  {
    name: 'touches new files',
    command: "touch 'touched.txt'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'touched.txt'))).toBe(true)
    },
  },
  {
    name: 'overwrites existing files',
    command: "echo 'OVERWRITTEN_CONTENT' > 'safe-root.txt'",
    assert(rootDir) {
      expect(readFileSync(join(rootDir, 'safe-root.txt'), 'utf8').trim()).toBe(
        'OVERWRITTEN_CONTENT',
      )
    },
  },
  {
    name: 'appends to existing files',
    command: "echo 'APPENDED_CONTENT' >> 'safe-root.txt'",
    assert(rootDir) {
      expect(readFileSync(join(rootDir, 'safe-root.txt'), 'utf8')).toContain(
        'APPENDED_CONTENT',
      )
    },
  },
  {
    name: 'creates directories',
    command: "mkdir 'created-dir'",
    assert(rootDir) {
      expect(statSync(join(rootDir, 'created-dir')).isDirectory()).toBe(true)
    },
  },
  {
    name: 'copies files',
    command: "cp 'safe-root.txt' 'copied.txt'",
    assert(rootDir) {
      expect(readFileSync(join(rootDir, 'copied.txt'), 'utf8')).toContain(
        'ROOT_ORIGINAL',
      )
    },
  },
  {
    name: 'copies directories recursively',
    command: "cp -R 'safe-dir' 'copied-dir'",
    assert(rootDir) {
      expect(
        readFileSync(join(rootDir, 'copied-dir', 'nested.txt'), 'utf8'),
      ).toContain('NESTED_ORIGINAL')
    },
  },
  {
    name: 'creates symbolic links',
    command: "ln -s 'safe-root.txt' 'safe-link.txt'",
    assert(rootDir) {
      expect(lstatSync(join(rootDir, 'safe-link.txt')).isSymbolicLink()).toBe(
        true,
      )
    },
  },
  {
    name: 'changes file permissions',
    command: "chmod 600 'safe-root.txt'",
    assert(rootDir) {
      expect(statSync(join(rootDir, 'safe-root.txt')).mode & 0o777).toBe(0o600)
    },
  },
  {
    name: 'renames files',
    command: "mv 'safe-root.txt' 'renamed.txt'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'safe-root.txt'))).toBe(false)
      expect(readFileSync(join(rootDir, 'renamed.txt'), 'utf8')).toContain(
        'ROOT_ORIGINAL',
      )
    },
  },
  {
    name: 'renames directories',
    command: "mv 'safe-dir' 'renamed-dir'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'safe-dir'))).toBe(false)
      expect(
        readFileSync(join(rootDir, 'renamed-dir', 'nested.txt'), 'utf8'),
      ).toContain('NESTED_ORIGINAL')
    },
  },
  {
    name: 'removes files',
    command: "rm 'safe-root.txt'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'safe-root.txt'))).toBe(false)
    },
  },
  {
    name: 'removes directories recursively',
    command: "rm -rf 'safe-dir'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'safe-dir'))).toBe(false)
    },
  },
  {
    name: 'removes empty directories',
    command: "rmdir 'empty-dir'",
    assert(rootDir) {
      expect(existsSync(join(rootDir, 'empty-dir'))).toBe(false)
    },
  },
]

function seedBasicWritableFixture(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true })
  mkdirSync(rootDir, { recursive: true })
  mkdirSync(join(rootDir, 'safe-dir'), { recursive: true })
  mkdirSync(join(rootDir, 'empty-dir'), { recursive: true })
  writeFileSync(join(rootDir, 'safe-root.txt'), 'ROOT_ORIGINAL\n')
  writeFileSync(join(rootDir, 'safe-dir', 'nested.txt'), 'NESTED_ORIGINAL\n')
}

function seedMandatoryDenyFixture(rootDir: string): void {
  seedBasicWritableFixture(rootDir)
  mkdirSync(join(rootDir, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(rootDir, '.bashrc'), 'DANGEROUS_ORIGINAL\n')
  writeFileSync(
    join(rootDir, '.claude', 'commands', 'test.md'),
    'COMMAND_ORIGINAL\n',
  )
}

function expectNotSandboxApply(stderr: string): void {
  expect(stderr.toLowerCase()).not.toContain('sandbox_apply')
}

function registerBasicWritableOperationSuite(input: {
  suiteName: string
  cwd: string
  readConfig: FsReadRestrictionConfig | undefined
  writeConfig: FsWriteRestrictionConfig | undefined
  seed(): void
  cleanupRoot: string
  homeDir?: string
}): void {
  describe(input.suiteName, () => {
    beforeAll(() => {
      if (skipIfUnsupportedPlatform()) {
        return
      }

      input.seed()
    })

    beforeEach(() => {
      if (skipIfUnsupportedPlatform()) {
        return
      }

      input.seed()
    })

    afterAll(() => {
      rmSync(input.cleanupRoot, { recursive: true, force: true })
    })

    for (const operationCase of BASIC_FS_OPERATION_CASES) {
      it(`allows ${operationCase.name}`, async () => {
        if (skipIfUnsupportedPlatform()) {
          return
        }

        const result = await runSandboxedCommand({
          cwd: input.cwd,
          command: operationCase.command,
          readConfig: input.readConfig,
          writeConfig: input.writeConfig,
          ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
        })

        expect(result.status).toBe(0)
        operationCase.assert(input.cwd)
      })
    }
  })
}

const MANDATORY_DENY_ROOT = join(
  tmpdir(),
  `writable-fs-ops-mandatory-${Date.now()}`,
)

registerBasicWritableOperationSuite({
  suiteName:
    'basic writable filesystem operations remain allowed with mandatory deny paths enabled',
  cwd: MANDATORY_DENY_ROOT,
  readConfig: undefined,
  writeConfig: {
    allowOnly: [MANDATORY_DENY_ROOT],
    denyWithinAllow: [],
  },
  seed() {
    seedMandatoryDenyFixture(MANDATORY_DENY_ROOT)
  },
  cleanupRoot: MANDATORY_DENY_ROOT,
})

describe('mandatory deny protections still block dangerous move operations', () => {
  beforeAll(() => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    seedMandatoryDenyFixture(MANDATORY_DENY_ROOT)
  })

  beforeEach(() => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    seedMandatoryDenyFixture(MANDATORY_DENY_ROOT)
  })

  it('blocks moving a dangerous file', async () => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    const result = await runSandboxedCommand({
      cwd: MANDATORY_DENY_ROOT,
      command: "mv '.bashrc' 'moved-bashrc'",
      readConfig: undefined,
      writeConfig: {
        allowOnly: [MANDATORY_DENY_ROOT],
        denyWithinAllow: [],
      },
    })

    expect(result.status).not.toBe(0)
    expectNotSandboxApply(result.stderr || '')
    expect(existsSync(join(MANDATORY_DENY_ROOT, '.bashrc'))).toBe(true)
    expect(existsSync(join(MANDATORY_DENY_ROOT, 'moved-bashrc'))).toBe(false)
  })

  it('blocks moving a dangerous ancestor directory', async () => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    const result = await runSandboxedCommand({
      cwd: MANDATORY_DENY_ROOT,
      command: "mv '.claude' 'moved-claude'",
      readConfig: undefined,
      writeConfig: {
        allowOnly: [MANDATORY_DENY_ROOT],
        denyWithinAllow: [],
      },
    })

    expect(result.status).not.toBe(0)
    expectNotSandboxApply(result.stderr || '')
    expect(existsSync(join(MANDATORY_DENY_ROOT, '.claude'))).toBe(true)
    expect(existsSync(join(MANDATORY_DENY_ROOT, 'moved-claude'))).toBe(false)
  })
})

const MAIN_AGENT_HOME = join(
  tmpdir(),
  `writable-fs-ops-main-agent-home-${Date.now()}`,
)
const MAIN_AGENT_ROOT = join(MAIN_AGENT_HOME, 'session-root')
const MAIN_AGENT_WORKSPACE = join(MAIN_AGENT_ROOT, 'workspace')
const MAIN_AGENT_NOTES = join(MAIN_AGENT_ROOT, 'notes')

function seedMainAgentFixture(): void {
  seedBasicWritableFixture(MAIN_AGENT_WORKSPACE)
  mkdirSync(MAIN_AGENT_NOTES, { recursive: true })
  writeFileSync(join(MAIN_AGENT_NOTES, 'note.txt'), 'NOTE_ORIGINAL\n')
  mkdirSync(join(MAIN_AGENT_WORKSPACE, 'protected-parent', 'protected'), {
    recursive: true,
  })
  writeFileSync(
    join(MAIN_AGENT_WORKSPACE, 'protected-parent', 'protected', 'secret.txt'),
    'SECRET_ORIGINAL\n',
  )
}

registerBasicWritableOperationSuite({
  suiteName:
    'basic writable filesystem operations remain allowed for allow_only read plus workspace write',
  cwd: MAIN_AGENT_WORKSPACE,
  readConfig: {
    mode: 'allow_only',
    denyOnly: [],
    allowOnly: [MAIN_AGENT_WORKSPACE, MAIN_AGENT_NOTES],
    denyWithinAllow: [],
  },
  writeConfig: {
    allowOnly: [MAIN_AGENT_WORKSPACE],
    denyWithinAllow: [],
  },
  seed() {
    rmSync(MAIN_AGENT_ROOT, { recursive: true, force: true })
    seedMainAgentFixture()
  },
  cleanupRoot: MAIN_AGENT_ROOT,
  homeDir: MAIN_AGENT_HOME,
})

const ALLOW_WITHIN_DENY_ROOT = join(
  tmpdir(),
  `writable-fs-ops-allow-within-deny-root-${Date.now()}`,
)
const ALLOW_WITHIN_DENY_WORKSPACE = join(ALLOW_WITHIN_DENY_ROOT, 'workspace')
const ALLOW_WITHIN_DENY_NOTES = join(ALLOW_WITHIN_DENY_ROOT, 'notes')

function seedAllowWithinDenyFixture(): void {
  seedBasicWritableFixture(ALLOW_WITHIN_DENY_WORKSPACE)
  mkdirSync(ALLOW_WITHIN_DENY_NOTES, { recursive: true })
  writeFileSync(join(ALLOW_WITHIN_DENY_NOTES, 'note.txt'), 'NOTE_ORIGINAL\n')
}

registerBasicWritableOperationSuite({
  suiteName:
    'basic writable filesystem operations remain allowed for denyOnly read plus allowWithinDeny workspace write',
  cwd: ALLOW_WITHIN_DENY_WORKSPACE,
  readConfig: {
    denyOnly: [ALLOW_WITHIN_DENY_ROOT],
    allowWithinDeny: [ALLOW_WITHIN_DENY_WORKSPACE, ALLOW_WITHIN_DENY_NOTES],
  },
  writeConfig: {
    allowOnly: [ALLOW_WITHIN_DENY_WORKSPACE],
    denyWithinAllow: [],
  },
  seed() {
    rmSync(ALLOW_WITHIN_DENY_ROOT, { recursive: true, force: true })
    seedAllowWithinDenyFixture()
  },
  cleanupRoot: ALLOW_WITHIN_DENY_ROOT,
})

describe('allow_only read protections still block move bypasses inside writable workspace', () => {
  beforeAll(() => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    rmSync(MAIN_AGENT_ROOT, { recursive: true, force: true })
    seedMainAgentFixture()
  })

  beforeEach(() => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    rmSync(MAIN_AGENT_ROOT, { recursive: true, force: true })
    seedMainAgentFixture()
  })

  it('blocks moving an ancestor directory of a read-denied path', async () => {
    if (skipIfUnsupportedPlatform()) {
      return
    }

    const result = await runSandboxedCommand({
      cwd: MAIN_AGENT_WORKSPACE,
      command: "mv 'protected-parent' 'moved-parent'",
      readConfig: {
        mode: 'allow_only',
        denyOnly: [],
        allowOnly: [MAIN_AGENT_WORKSPACE, MAIN_AGENT_NOTES],
        denyWithinAllow: [
          join(MAIN_AGENT_WORKSPACE, 'protected-parent', 'protected'),
        ],
      },
      writeConfig: {
        allowOnly: [MAIN_AGENT_WORKSPACE],
        denyWithinAllow: [],
      },
      homeDir: MAIN_AGENT_HOME,
    })

    expect(result.status).not.toBe(0)
    expectNotSandboxApply(result.stderr || '')
    expect(
      existsSync(join(MAIN_AGENT_WORKSPACE, 'protected-parent', 'protected')),
    ).toBe(true)
    expect(existsSync(join(MAIN_AGENT_WORKSPACE, 'moved-parent'))).toBe(false)
  })
})
