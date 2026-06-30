/**
 * Pure helpers for backend-config decisions, extracted so they can be unit
 * tested without a React component harness (the repo has no React testing
 * infrastructure). Keep these free of side effects and React imports.
 */

export interface BackendConfigFields {
  baseUrl?: string
  token?: string
}

/**
 * Returns true when a backend config has both a non-empty baseUrl and token.
 * Used by App.tsx to decide whether to refresh the settings agents/models list
 * after hydration: if there's no usable config, the refresh would fail
 * silently (getAgents throws) and there's nothing to populate, so we skip the
 * nonce bump and wait for the user to Save settings.
 */
export function isBackendConfigured(config: BackendConfigFields | null | undefined): boolean {
  if (!config) return false
  return Boolean(config.baseUrl?.trim() && config.token?.trim())
}

/**
 * Render a backend model id as a human-friendly display name.
 *
 * Strips a trailing `@<suffix>` (a dated/default qualifier some providers need
 * on the wire, e.g. antigravity's `claude-opus-4-8@default`) BEFORE matching
 * the claude name pattern. Without this, the claude regex's `(?:-.*)?` tail
 * swallowed the minor version together with `@default`, collapsing
 * `claude-opus-4-6/7/8@default` to all display as "Opus 4". The underlying id
 * is still used as the <option value>; this is display-only.
 */
export function formatModelName(m: string): string {
  if (m === '') return 'Default'

  const display = m.split('@')[0]

  // Modern claude model names (claude-opus-4-5, claude-sonnet-4-6, …).
  if (display.startsWith('claude-')) {
    const match = display.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-.*)?$/i);
    if (match) {
      const type = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const major = match[2];
      const minor = match[3];
      return `${type} ${major}${minor ? `.${minor}` : ''}`;
    }
  }

  if (display.startsWith('gpt-4o')) return 'GPT-4o'
  if (display === 'gpt-4-turbo') return 'GPT-4 Turbo'
  if (display === 'gpt-4') return 'GPT-4'
  return display.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}
