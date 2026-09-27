// The Broadcast's sheets (the full script, the Bookplate) and the Keyboard
// dialog. Each is a native <dialog> opened with showModal(): the rest of the
// page is inert while it is open (focus stays inside it), Esc closes it, and
// so does a press on the scrim. Closing hands focus back to the control that
// opened it, or, if that control has gone, to the fallback the page names.
// On a phone style.css draws a sheet from the bottom; on a tablet or desktop
// it is a centred dialog.

export interface Sheet {
  open(opener: HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
}

/** Whether an element can take focus back: still in the page and drawn. */
function focusable(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null;
}

export function mountSheet(dialog: HTMLDialogElement, fallback: () => HTMLElement | null, onOpen?: () => void): Sheet {
  let opener: HTMLElement | null = null;

  dialog.addEventListener("close", () => {
    const back = focusable(opener) ? opener : fallback();
    opener = null;
    back?.focus();
  });
  // A press on the scrim (the dialog's own box, outside its content) closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  for (const b of dialog.querySelectorAll<HTMLButtonElement>("[data-close]")) b.addEventListener("click", () => dialog.close());

  return {
    open(from) {
      if (dialog.open) return;
      opener = from;
      onOpen?.();
      dialog.showModal();
    },
    close: () => {
      if (dialog.open) dialog.close();
    },
    isOpen: () => dialog.open,
  };
}
