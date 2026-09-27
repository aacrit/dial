// The Broadcast's keyboard (design/spec.md 1.6), as a pure mapping from a
// key press to what it does. Keys do nothing while focus is in a text field
// or on a control that uses the key itself (Space on a button presses it;
// the arrow keys turn a slider), and nothing with Ctrl, Alt or Cmd held.

export type KeyAction = "playpause" | "back" | "stop" | "forward" | "line-prev" | "line-next" | "shortcuts";

export interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/** What the focused element is: a text field takes every key; a control takes Space. */
export type FocusKind = "text" | "control" | "none";

export function keyAction(e: KeyPress, focus: FocusKind): KeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey || focus === "text") return null;
  switch (e.key) {
    case " ":
      return focus === "control" ? null : "playpause";
    case "j":
    case "J":
      return "back";
    case "k":
    case "K":
      return "stop";
    case "l":
    case "L":
      return "forward";
    case "[":
      return "line-prev";
    case "]":
      return "line-next";
    case "?":
      return "shortcuts";
    default:
      return null;
  }
}

/** The focused element's kind, from its tag, type and role (a plain description, so tests need no DOM). */
export function focusKind(el: { tagName: string; type?: string; role?: string | null; isContentEditable?: boolean } | null): FocusKind {
  if (!el) return "none";
  const tag = el.tagName.toUpperCase();
  if (el.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") return "text";
  if (tag === "INPUT") return ["button", "submit", "reset", "checkbox", "radio", "range"].includes((el.type ?? "").toLowerCase()) ? "control" : "text";
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return "control";
  if (el.role && ["slider", "button", "link", "checkbox", "switch", "tab", "menuitem"].includes(el.role)) return "control";
  return "none";
}

/** The shortcuts sheet: exactly the keys this page answers (the Repertory search, "/", comes with search). */
export const SHORTCUTS: readonly [string[], string][] = [
  [["Space"], "Play or pause"],
  [["J"], "Back 10 seconds. Press again to scrub faster."],
  [["K"], "Stop scrubbing and pause"],
  [["L"], "Forward 10 seconds. Press again to scrub faster."],
  [["[", "]"], "Previous or next line"],
  [["?"], "Show the shortcuts"],
  [["Esc"], "Close a sheet or dialog"],
];
