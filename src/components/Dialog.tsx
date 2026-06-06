// Themed, accessible dialogs (PLAN §6) replacing native window.confirm()/prompt(), which
// can't be styled or themed and break the dark/light look. Modal is the shared shell:
// backdrop + Esc/backdrop close, role=dialog + aria-modal, focus moved in on open and
// restored on close, and a Tab focus-trap that cycles all focusable controls. ConfirmDialog
// and PromptDialog are thin specializations. Colors follow the zinc-mirroring theme trick
// (HANDOFF): zinc-950 panel + zinc-800 border read correctly in both themes.
import { useEffect, useRef, useState } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  labelledBy,
  initialFocusRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const focusFirst = () => {
      const target =
        initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current;
      target?.focus();
    };
    focusFirst();
    return () => restoreRef.current?.focus();
  }, [open, initialFocusRef]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal open={open} onClose={onClose} labelledBy="confirm-title" initialFocusRef={confirmRef}>
      <h2 id="confirm-title" className="text-base font-semibold text-zinc-100">
        {title}
      </h2>
      <p className="mt-2 text-sm text-zinc-400">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          onClick={() => {
            onConfirm();
            onClose();
          }}
          className={
            danger
              ? 'rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500'
              : 'rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-950 hover:bg-emerald-400'
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  confirmLabel = 'Save',
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  // Reset the field to the current initial value each time the dialog opens, and select it
  // so typing replaces (matching native prompt's pre-filled-and-selected behavior).
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // Select after focus (Modal focuses the first control = this input).
      queueMicrotask(() => inputRef.current?.select());
    }
  }, [open, initialValue]);

  const submit = () => {
    const v = value.trim();
    if (v) {
      onSubmit(v);
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="prompt-title" initialFocusRef={inputRef}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="prompt-title" className="text-base font-semibold text-zinc-100">
          {title}
        </h2>
        <label className="mt-3 block text-sm text-zinc-400">
          {label}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-500"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
