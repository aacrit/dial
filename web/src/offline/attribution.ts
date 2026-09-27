// Which tab each of the offline helper's requests was made for, as pure
// functions, so the Seal's log stays true per tab. The helper notes a
// request just before it fetches on a client's behalf (a page, a page's
// render worker, or the new page for a navigation). When the browser's
// Resource Timing entry for that address arrives, the note whose start is
// closest claims it. A render worker is a client of its own that no log
// reads, so the helper also notes which page started each worker (owners),
// and a worker's entries go to that page. An entry nobody claimed (the shell
// the helper keeps for every tab) is the helper's own, shared by every Dial
// tab, and is marked so.

import type { RawEntry } from "../request-log";

/** A request the helper made for one client. `at` is in epoch ms, like RawEntry.t; `settled` is when its response arrived. */
export interface PendingFetch {
  url: string;
  at: number;
  clientId: string;
  settled?: number;
}

/** An entry, with the client it was made for (null: the helper's own, shared by every tab). */
export interface HelperEntry {
  entry: RawEntry;
  clientId: string | null;
}

/**
 * A note is kept this long after its response arrived: the browser writes
 * the entry once the body has been read, which for a large file can be well
 * after the headers.
 */
export const SETTLED_GRACE_MS = 60_000;

/** A note whose response never arrived is dropped after this long. */
export const UNSETTLED_MAX_MS = 5 * 60_000;

/** How many entries the helper remembers to answer a page that asks. */
export const HELPER_MEMORY = 500;

/** Worker client id to the id of the client that started it. */
export type Owners = ReadonlyMap<string, string>;

/** The page a client belongs to: a worker's owner (followed up the chain), or the client itself. */
export function ownerOf(owners: Owners, clientId: string): string {
  let id = clientId;
  for (let i = 0; i < 8 && owners.has(id); i++) id = owners.get(id)!;
  return id;
}

/**
 * Claims an entry for the client it was made for: of the notes for the same
 * address that started no later than the entry (5 ms of clock slack), the
 * one whose start is closest. Removes that note.
 */
export function claim(pending: PendingFetch[], entry: RawEntry): string | null {
  let best = -1;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    if (p.url !== entry.url || entry.t < p.at - 5) continue;
    if (best < 0 || Math.abs(entry.t - p.at) < Math.abs(entry.t - pending[best]!.at)) best = i;
  }
  if (best < 0) return null;
  return pending.splice(best, 1)[0]!.clientId;
}

/** Marks the newest unsettled note for this address and client as settled at `now`. */
export function settle(pending: PendingFetch[], url: string, clientId: string, now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    if (p.url === url && p.clientId === clientId && p.settled === undefined) {
      p.settled = now;
      return;
    }
  }
}

/** Drops notes whose response arrived more than the grace ago, or that never settled. */
export function prune(pending: PendingFetch[], now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    const stale = p.settled !== undefined ? now - p.settled > SETTLED_GRACE_MS : now - p.at > UNSETTLED_MAX_MS;
    if (stale) pending.splice(i, 1);
  }
}

/** Groups entries for delivery: each page gets its own and its workers'; the unclaimed go to every page, marked shared. */
export function groupByClient(entries: readonly HelperEntry[], owners: Owners = new Map()): { own: Map<string, RawEntry[]>; shared: RawEntry[] } {
  const own = new Map<string, RawEntry[]>();
  const shared: RawEntry[] = [];
  for (const { entry, clientId } of entries) {
    if (clientId === null) {
      shared.push(entry);
      continue;
    }
    const page = ownerOf(owners, clientId);
    own.set(page, [...(own.get(page) ?? []), entry]);
  }
  return { own, shared };
}

/** What a page that asks is owed: its own and its workers' entries after `afterOwn`, and the shared ones after `afterShared`. */
export function answerFor(memory: readonly HelperEntry[], clientId: string, afterOwn: number, afterShared: number, owners: Owners = new Map()): { own: RawEntry[]; shared: RawEntry[] } {
  const own: RawEntry[] = [];
  const shared: RawEntry[] = [];
  for (const { entry, clientId: c } of memory) {
    const t = Math.round(entry.t);
    if (c === null) {
      if (t > afterShared) shared.push(entry);
    } else if (ownerOf(owners, c) === clientId && t > afterOwn) own.push(entry);
  }
  return { own, shared };
}

/** Remembers entries, newest last, at most HELPER_MEMORY. */
export function remember(memory: HelperEntry[], add: readonly HelperEntry[]): void {
  memory.push(...add);
  if (memory.length > HELPER_MEMORY) memory.splice(0, memory.length - HELPER_MEMORY);
}
