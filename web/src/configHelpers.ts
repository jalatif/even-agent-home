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
