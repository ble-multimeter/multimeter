// Accessible keyboard-shortcuts overlay (toggle with "?"). Modal dialog: labelled,
// Esc/backdrop to close, focus moved in on open and restored on close, Tab kept inside.
import { useEffect, useRef } from 'react';

export interface Shortcut {
  keys: string;
  label: string;
}

// Single source of truth, shared with App's key handler so the two can't drift.
export const SHORTCUTS: Shortcut[] = [
  { keys: 'c', label: 'Connect / disconnect the meter' },
  { keys: 'b', label: 'Toggle the meter backlight' },
  { keys: 'h', label: 'Hold / release the readout' },
  { keys: 'Space', label: 'Pin the current reading' },
  { keys: 'r', label: 'Start / stop recording' },
  { keys: 'p', label: 'Pause / resume recording' },
  { keys: 'e', label: 'Export CSV of the recording' },
  { keys: 'i', label: 'Export the chart as PNG' },
  { keys: 'v', label: 'Switch Live / Recordings view' },
  { keys: 's', label: 'Announce the current reading' },
  { keys: 't', label: 'Toggle light / dark theme' },
  { keys: '?', label: 'Show or hide this help' },
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, [open]);

  if (!open) return null;

  // Minimal focus trap: with one focusable control, Tab just stays on it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Tab') {
      e.preventDefault();
      closeRef.current?.focus();
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
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-base font-semibold text-zinc-100">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>
        <dl className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-4">
              <dt className="text-sm text-zinc-300">{s.label}</dt>
              <dd>
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-xs text-zinc-200">
                  {s.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-zinc-400">Shortcuts are ignored while typing in a field.</p>
      </div>
    </div>
  );
}
