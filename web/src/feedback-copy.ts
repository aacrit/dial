// The feedback form's checks and words, kept pure so tests can hold them
// to the Worker's rules (worker/src/config.ts MAX_FEEDBACK_TEXT_BYTES,
// worker/src/index.ts's error codes; tests/hardening.test.ts). The page
// checks what it can before sending, so a message the Worker would refuse
// is never sent, and every refusal says what to do next.

/** The Worker's cap on a message, in UTF-8 bytes (what D1 stores), not characters. */
export const MAX_FEEDBACK_BYTES = 4_000;

export const FEEDBACK_EMPTY = "Write a message first, then send it.";
export const FEEDBACK_TOO_LONG = "That message is too long. Shorten it, then send again.";
export const FEEDBACK_DAY_FULL = "We have had a lot of feedback today. Please try again tomorrow.";
export const FEEDBACK_TOO_MANY = "Too many messages from this network. Wait a minute, then send again.";
export const FEEDBACK_FAILED = "Could not send that. Please try again.";

/** Why a message cannot be sent as it is, or null when it can. The text is trimmed first, as the Worker does. */
export function feedbackProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return FEEDBACK_EMPTY;
  if (new TextEncoder().encode(t).byteLength > MAX_FEEDBACK_BYTES) return FEEDBACK_TOO_LONG;
  return null;
}

/**
 * What the form says when the Worker refused a message: the day's shared
 * ceiling (429 daily_ceiling_reached) is not the per-network limit (429
 * rate_limited, or the zone's own block, which has no JSON body), and a
 * message too long gets the fix, not "try again".
 */
export function feedbackFailure(status: number, error: string | undefined): string {
  if (error === "feedback_too_long") return FEEDBACK_TOO_LONG;
  if (status === 429) return error === "daily_ceiling_reached" ? FEEDBACK_DAY_FULL : FEEDBACK_TOO_MANY;
  if (error === "invalid_feedback") return FEEDBACK_EMPTY;
  return FEEDBACK_FAILED;
}
