// Library exports
export { SandboxManager } from './sandbox/sandbox-manager.js'
export { SandboxViolationStore } from './sandbox/sandbox-violation-store.js'
export {
  executeSandboxedCommand,
  type SandboxExecOptions,
  type SandboxExecResult,
} from './sandbox/sandbox-exec.js'
export {
  SandboxPermissionError,
  isSandboxPermissionError,
  type SandboxPermissionIssue,
} from './sandbox/sandbox-permission-error.js'
export type { SandboxNetworkBlockEvent } from './sandbox/sandbox-network-event-store.js'

// Configuration types and schemas
export type {
  SandboxRuntimeConfig,
  NetworkConfig,
  FilesystemConfig,
  IgnoreViolationsConfig,
} from './sandbox/sandbox-config.js'

export {
  SandboxRuntimeConfigSchema,
  NetworkConfigSchema,
  FilesystemConfigSchema,
  IgnoreViolationsConfigSchema,
  RipgrepConfigSchema,
} from './sandbox/sandbox-config.js'

// Schema types and utilities
export type {
  SandboxAskCallback,
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  NetworkRestrictionConfig,
  NetworkHostPattern,
} from './sandbox/sandbox-schemas.js'

// Platform-specific utilities
export type { SandboxViolationEvent } from './sandbox/macos-sandbox-utils.js'
export { type SandboxDependencyCheck } from './sandbox/linux-sandbox-utils.js'

// Utility functions
export { getDefaultWritePaths } from './sandbox/sandbox-utils.js'

// Platform utilities
export { getWslVersion } from './utils/platform.js'
export type { Platform } from './utils/platform.js'
