// The casting rule's version, alone in its own module so the offline helper
// (sw.ts) can import it without pulling in casting or the voice table.

/**
 * Bump it whenever a change to web/src/engine/cast.ts (or the voice table it
 * reads) can give any work a different set of voices: a new narrator, a new
 * pool, a new scoring rule. Works saved for offline under another version
 * are then shown as "Saved on an older version" (offline/routes.ts
 * offlineKey) until the listener reopens Dial with a connection.
 * tests/offline.test.ts pins each version's voice sets.
 */
export const CAST_ENGINE_VERSION = "2";
