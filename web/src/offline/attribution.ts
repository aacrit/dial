// Which tab each of the offline helper's requests was made for, as pure
// functions, so the Seal's log stays true per tab. The helper notes a
// request just before it fetches on a page's behalf (the page's client id,
// or the new page's for a navigation). When the browser's Resource Timing
// entry for that address arrives, it is claimed by the oldest such note
// that fits in time. An entry nobody claims (the shell the helper keeps for
// every tab) is the helper's own, shared by every Dial tab, and is marked so.

import type { RawEntry } from "../request-log";

/** A request the helper is about to make for one page. `at` is in epoch ms, like RawEntry.t. */
export interface PendingFetch {
  url: string;
  at: number;
  clientId: string;
}

/** An entry, with the page it was made for (null: the helper's own, shared by every tab). */
export interface HelperEntry {
  entry: RawEntry;
  clientId: string | null;
}

/** A note older than this is not matched to an entry any more. */
export const MATCH_WINDOW_MS = 10_000;

/** How many entries the helper remembers to answer a page that asks. */
export const HELPER_MEMORY = 500;

/** Claims an entry for the page that asked for it: the oldest note for the same address that fits in time. Removes the note. */
export function claim(pending: PendingFetch[], entry: RawEntry): string | null {
  const i = pending.findIndex((p) => p.url === entry.url && entry.t >= p.at - 5 && entry.t - p.at <= MATCH_WINDOW_MS);
  if (i < 0) return null;
  return pending.splice(i, 1)[0]!.clientId;
}

/** Drops notes too old to be matched. */
export function prune(pending: PendingFetch[], now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) if (now - pending[i]!.at > MATCH_WINDOW_MS) pending.splice(i, 1);
}

/** Groups entries for delivery: each page gets its own; the unclaimed go to every page, marked shared. */
export function groupByClient(entries: readonly HelperEntry[]): { own: Map<string, RawEntry[]>; shared: RawEntry[] } {
  const own = new Map<string, RawEntry[]>();
  const shared: RawEntry[] = [];
  for (const { entry, clientId } of entries) {
    if (clientId === null) shared.push(entry);
    else own.set(clientId, [...(own.get(clientId) ?? []), entry]);
  }
  return { own, shared };
}

/** What a page that asks is owed: its own entries and the shared ones, newer than the newest it already holds. */
export function answerFor(memory: readonly HelperEntry[], clientId: string, after: number): { own: RawEntry[]; shared: RawEntry[] } {
  const own: RawEntry[] = [];
  const shared: RawEntry[] = [];
  for (const { entry, clientId: c } of memory) {
    if (Math.round(entry.t) <= after) continue;
    if (c === clientId) own.push(entry);
    else if (c === null) shared.push(entry);
  }
  return { own, shared };
}

/** Remembers entries, newest last, at most HELPER_MEMORY. */
export function remember(memory: HelperEntry[], add: readonly HelperEntry[]): void {
  memory.push(...add);
  if (memory.length > HELPER_MEMORY) memory.splice(0, memory.length - HELPER_MEMORY);
}
