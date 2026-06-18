/**
 * Persistent key/value store adapter.
 *
 * Phone target (Even Hub / G2): routes reads and writes through the Even Hub
 * bridge's `getLocalStorage` / `setLocalStorage` (the SDK's app-scoped KV
 * store, which survives WebView reloads and force-closes). `window.localStorage`
 * is a fallback for browser dev where the bridge is absent. The bridge path
 * always wins when it is available because `localStorage` is unreliable on
 * phone WebViews (host app clears it on relaunch).
 */

export interface PersistentStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem?(key: string): Promise<void>
}

let bridgeProvider: (() => PersistentStorage | null) | null = null

/**
 * Register the bridge-backed storage implementation. Called once from
 * `App.tsx` after `EvenHubGlassesBridge.create(...)` resolves. Until
 * registration, reads and writes fall back to `window.localStorage` so the
 * module can be imported anywhere without ordering constraints.
 */
export function registerBridgeStorage(provider: () => PersistentStorage | null): void {
  bridgeProvider = provider
}

export function resolveStorage(): PersistentStorage | null {
  const fromBridge = bridgeProvider?.()
  if (fromBridge) return fromBridge
  if (typeof window === 'undefined') return null
  return {
    async getItem(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    async setItem(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch (e) {
        console.warn(`[storage] localStorage.setItem failed for ${key}`, e)
      }
    },
    async removeItem(key) {
      try {
        window.localStorage.removeItem(key)
      } catch (e) {
        console.warn(`[storage] localStorage.removeItem failed for ${key}`, e)
      }
    },
  }
}

export async function storageGet(key: string): Promise<string | null> {
  return resolveStorage()?.getItem(key) ?? null
}

export async function storageSet(key: string, value: string): Promise<void> {
  await resolveStorage()?.setItem(key, value)
}

export async function storageRemove(key: string): Promise<void> {
  await resolveStorage()?.removeItem?.(key)
}
