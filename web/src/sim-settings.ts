/**
 * Simulator-only settings capture/restore for the record/replay skill.
 *
 * The skill treats settings as an opaque blob: at record time it captures a
 * settings.snapshot console event; at replay time it passes the blob back via a
 * URL query param. This module is the app's side of that contract — it decides
 * WHAT the settings are (apiConfig + agentConfigs) and HOW to restore them.
 *
 * Everything here is gated by `__sim_session` in the URL. On real glasses or in
 * normal dev (no param), every function is a no-op — zero behavior change.
 */

import { storageGet, storageSet } from './storage'
import { logTestEvent } from './testMode'

const SIM_SESSION_PARAM = '__sim_session'
const SIM_SETTINGS_PARAM = '__sim_settings'
// The persisted keys that define the app's runtime config. These are what get
// captured + restored. Add keys here if the app gains new config dimensions.
const SETTING_KEYS = ['apiConfig', 'agentConfigs']

/** True only when running under the simulator record/replay skill. */
export function isSimSession(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has(SIM_SESSION_PARAM)
}

/**
 * Emit the current persisted settings as a console event the skill captures.
 * Called at recording START (settings freeze point) and optionally on changes.
 * No-op outside a sim session.
 */
export async function emitSettingsSnapshot(): Promise<void> {
  if (!isSimSession()) return
  const settings: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) {
    try {
      const raw = await storageGet(key)
      settings[key] = raw ? JSON.parse(raw) : null
    } catch {
      settings[key] = null
    }
  }
  logTestEvent('settings.snapshot', { settings })
}

/**
 * Read recorded settings from the URL (injected by the skill at replay) and
 * write them into the persistent store BEFORE the app boots, so the app comes
 * up in the recorded state. No-op outside a sim session.
 */
export async function hydrateSimSettings(): Promise<void> {
  if (!isSimSession()) return
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const blob = params.get(SIM_SETTINGS_PARAM)
  if (!blob) return
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(atob(blob))
  } catch {
    console.warn('[sim-settings] failed to decode __sim_settings param')
    return
  }
  for (const key of SETTING_KEYS) {
    if (settings[key] != null) {
      try {
        await storageSet(key, JSON.stringify(settings[key]))
      } catch {
        console.warn(`[sim-settings] failed to restore ${key}`)
      }
    }
  }
}
