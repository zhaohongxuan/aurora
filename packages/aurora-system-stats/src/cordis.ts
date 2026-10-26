/**
 * The subset of Cordis this plugin is written against.
 *
 * A dsh plugin package is loaded from the profile's `node_modules`, where the
 * Cordis runtime lives; it is never bundled, so declaring the handful of members
 * used here keeps the package buildable without a second copy of Cordis.
 * @module aurora-system-stats/src/cordis
 */

/** A disposable callback: disposing withdraws the contribution. */
export type Disposer = () => void

/** A named logger facade. */
export interface Logger {
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
  debug(message: string, ...rest: unknown[]): void
}

/** The parts of a Cordis `Context` a plain host plugin needs. */
export interface PluginContext {
  readonly logger: (name?: string) => Logger
  /**
   * Run `callback` once every named service exists, handing it a scoped child
   * context; the returned effect is withdrawn when the plugin unloads.
   */
  inject(names: readonly string[], callback: (scope: PluginContext) => void): Disposer
  /** Register a lifecycle effect, with an optional label for diagnostics. */
  effect(callback: () => Disposer | Promise<Disposer>, label?: string): Disposer
  /** Read a service from this context. */
  get<T = unknown>(name: string): T | undefined
}
