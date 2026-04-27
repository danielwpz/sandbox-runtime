// Filesystem and network restriction configs built from public sandbox config.

export type FsReadRestrictionMode = 'deny_only' | 'allow_only'
export type FsWriteRestrictionMode = 'allow_only' | 'deny_only'
export type NetworkRestrictionMode = 'allow_only' | 'deny_only'

/**
 * Read restriction config using a "deny then allow-back" pattern.
 *
 * Semantics:
 * - `undefined` = no restrictions (allow all reads)
 * - `{denyOnly: []}` = no restrictions (empty deny list = allow all reads)
 * - `{denyOnly: [...paths]}` = deny reads from these paths, allow all others
 * - `{denyOnly: [...paths], allowWithinDeny: [...paths]}` = deny reads from
 *   denyOnly paths, but re-allow reads within allowWithinDeny paths.
 *   allowWithinDeny takes precedence over denyOnly (most-specific rule wins).
 *
 * This is maximally permissive by default - only explicitly denied paths are blocked.
 */
export interface FsReadRestrictionConfig {
  denyOnly: string[]
  allowWithinDeny?: string[]
  mode?: FsReadRestrictionMode
  allowOnly?: string[]
  denyWithinAllow?: string[]
}

/**
 * Write restriction config.
 *
 * Semantics:
 * - `undefined` = no restrictions (allow all writes)
 * - `{mode: "deny_only", denyWithinAllow: [...]}` = deny writes to these paths,
 *   allow all others
 * - `{allowOnly: [], denyWithinAllow: []}` = maximally restrictive (deny ALL writes)
 * - `{allowOnly: [...paths], denyWithinAllow: [...]}` = allow writes only to these paths,
 *   with exceptions for denyWithinAllow
 *
 * This is maximally restrictive by default when mode is omitted - only explicitly
 * allowed paths are writable. Note: Empty `allowOnly` means NO paths are writable
 * in allow-only mode (unlike read's empty denyOnly).
 */
export interface FsWriteRestrictionConfig {
  mode?: FsWriteRestrictionMode
  allowOnly: string[]
  denyWithinAllow: string[]
}

/**
 * Network restriction config (internal structure built from permission rules).
 *
 * This uses an "allow-only" pattern (like write restrictions):
 * - `allowedHosts` = hosts that are explicitly allowed
 * - `deniedHosts` = hosts that are explicitly denied (checked first, before allowedHosts)
 *
 * Semantics:
 * - `undefined` = maximally restrictive (deny all network)
 * - `{allowedHosts: [], deniedHosts: []}` = maximally restrictive (nothing allowed)
 * - `{allowedHosts: [...], deniedHosts: [...]}` = apply allow/deny rules
 *
 * Note: Empty `allowedHosts` means NO hosts are allowed (unlike read's empty denyOnly).
 */
export interface NetworkRestrictionConfig {
  mode?: NetworkRestrictionMode
  allowedHosts?: string[]
  deniedHosts?: string[]
}

export function getFsReadRestrictionMode(
  config: FsReadRestrictionConfig | undefined,
): FsReadRestrictionMode {
  return config?.mode ?? 'deny_only'
}

export function hasFsReadRestrictions(
  config: FsReadRestrictionConfig | undefined,
): boolean {
  if (!config) {
    return false
  }

  if (getFsReadRestrictionMode(config) === 'allow_only') {
    return true
  }

  return config.denyOnly.length > 0
}

export function getFsWriteRestrictionMode(
  config: FsWriteRestrictionConfig | undefined,
): FsWriteRestrictionMode {
  return config?.mode ?? 'allow_only'
}

export function getNetworkRestrictionMode(
  config: NetworkRestrictionConfig | undefined,
): NetworkRestrictionMode {
  return config?.mode ?? 'allow_only'
}

export type NetworkHostPattern = {
  host: string
  port: number | undefined
}

export type SandboxAskCallback = (
  params: NetworkHostPattern,
) => Promise<boolean>
