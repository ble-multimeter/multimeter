// Copy the current reading to the clipboard, exactly as the hero shows it ("4.762 V", "OL").
// Lives in the hero action row next to Hold. Renders nothing when there's no value to copy.
import { useEffect, useRef, useState } from 'react';
import type { Reading } from '../ble/types';

export function CopyButton({ reading }: { reading: Reading }) {
  const { overload, displayText, displayUnit } = reading;
  const canCopy = overload || !!displayText;
  const text = `${overload ? 'OL' : displayText}${displayUnit ? ` ${displayUnit}` : ''}`;

  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (!canCopy) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / denied) — no-op.
    }
  };

  return (
    <button
      onClick={copy}
      aria-label={`Copy reading ${text} to clipboard`}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-4 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {copied ? (
        <>
          <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
            <path d="M7.5 13.5 4 10l-1.3 1.3L7.5 16 17 6.5 15.7 5.2z" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
            <path d="M13 1H5a2 2 0 0 0-2 2v9h2V3h8V1zm3 4H9a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 12H9V7h7v10z" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}
