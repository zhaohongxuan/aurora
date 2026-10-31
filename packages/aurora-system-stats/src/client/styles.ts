/**
 * Injects this bundle's stylesheet once per page.
 *
 * The bundle is served as a classic script, so a `?inline` CSS import cannot
 * work; the sheet travels as a string and is tagged with `data-plugin` and
 * `data-plugin-css`, the markers the DSH module system uses to claim a style for
 * its owning plugin and remove it again on HMR or disable.
 * @module aurora-system-stats/client/styles
 */

import css from './styles.css'

/** Style tag identity: one per plugin artifact. */
const TAG_ID = 'aurora-system-stats/styles.css?v=3'

/** Adopt the bundle's stylesheet into the document, idempotently. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(TAG_ID)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'aurora-system-stats'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = css
  document.head.appendChild(tag)
}
