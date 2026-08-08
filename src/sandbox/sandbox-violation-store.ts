import { type SandboxViolationEvent } from './macos-sandbox-utils.js'
import { encodeSandboxedCommand } from './sandbox-utils.js'

/**
 * In-memory tail for sandbox violations
 */
export class SandboxViolationStore {
  private violations: Array<{
    sequence: number
    event: SandboxViolationEvent
  }> = []
  private totalCount = 0
  private readonly maxSize = 100
  private listeners: Set<(violations: SandboxViolationEvent[]) => void> =
    new Set()

  addViolation(violation: SandboxViolationEvent): void {
    this.totalCount++
    this.violations.push({
      sequence: this.totalCount,
      event: violation,
    })
    if (this.violations.length > this.maxSize) {
      this.violations = this.violations.slice(-this.maxSize)
    }
    this.notifyListeners()
  }

  getViolations(limit?: number): SandboxViolationEvent[] {
    if (limit === undefined) {
      return this.violations.map(({ event }) => event)
    }
    return this.violations.slice(-limit).map(({ event }) => event)
  }

  getCount(): number {
    return this.violations.length
  }

  getTotalCount(): number {
    return this.totalCount
  }

  getViolationsForCommand(command: string): SandboxViolationEvent[] {
    const commandBase64 = encodeSandboxedCommand(command)
    return this.violations
      .map(({ event }) => event)
      .filter(v => v.encodedCommand === commandBase64)
  }

  getViolationsForCommandSince(
    command: string,
    afterSequence: number,
  ): SandboxViolationEvent[] {
    const commandBase64 = encodeSandboxedCommand(command)
    return this.violations
      .filter(
        ({ sequence, event }) =>
          sequence > afterSequence && event.encodedCommand === commandBase64,
      )
      .map(({ event }) => event)
  }

  clear(): void {
    this.violations = []
    // Don't reset totalCount when clearing
    this.notifyListeners()
  }

  subscribe(
    listener: (violations: SandboxViolationEvent[]) => void,
  ): () => void {
    this.listeners.add(listener)
    listener(this.getViolations())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyListeners(): void {
    // Always notify with all violations so listeners can track the full count
    const violations = this.getViolations()
    this.listeners.forEach(listener => listener(violations))
  }
}
