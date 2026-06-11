// The derived-channel builder (Phase 7, plan-7.md §6): pick input A, an operation (× ÷ + −), and
// input B, name the result, and add it. The resulting unit is previewed live via deriveUnit, and an
// invalid +/− unit pair (e.g. V + A) is blocked with an inline message — no silent garbage. Needs
// at least two meter channels to do anything.

import { useState } from 'react';
import type { Meters } from '@ble-multimeter/react';
import { deriveUnit, OP_SYMBOL, type DerivedOp } from '@ble-multimeter/protocol';

const OPS: DerivedOp[] = ['mul', 'div', 'add', 'sub'];

export function DerivedBuilder({ meters }: { meters: Meters }) {
  const inputs = meters.meters; // derived inputs are meter channels (MVP)
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('P');
  const [op, setOp] = useState<DerivedOp>('mul');
  const [a, setA] = useState(inputs[0]?.id ?? '');
  const [b, setB] = useState(inputs[1]?.id ?? '');

  if (inputs.length < 2) {
    return (
      <p className="text-xs text-zinc-500">
        Add a second meter to combine channels into a derived value (e.g. P = V × I).
      </p>
    );
  }

  // Resolve A/B selections against the *current* channels: a previously-picked channel that was
  // removed (or a stale default) falls back to a real one, and B is forced to differ from A so a
  // channel can never be combined with itself (V × V / V − V are meaningless here).
  const aId = inputs.some(m => m.id === a) ? a : inputs[0]!.id;
  const bId =
    inputs.some(m => m.id === b) && b !== aId
      ? b
      : (inputs.find(m => m.id !== aId)?.id ?? inputs[0]!.id);
  const aUnit = inputs.find(m => m.id === aId)?.reading?.baseUnit ?? '';
  const bUnit = inputs.find(m => m.id === bId)?.reading?.baseUnit ?? '';
  const preview = deriveUnit(op, aUnit, bUnit);
  const aRole = inputs.find(m => m.id === aId)?.role ?? aId;
  const bRole = inputs.find(m => m.id === bId)?.role ?? bId;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start rounded-md border border-violet-800/60 px-3 py-1.5 text-sm text-violet-300 hover:bg-violet-950/40"
      >
        + Add derived channel
      </button>
    );
  }

  const add = () => {
    if (!preview.ok) return;
    const id = meters.addDerived({
      label: label.trim() || 'X',
      op,
      aChannelId: aId,
      bChannelId: bId,
    });
    if (id) setOpen(false);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-violet-900/50 bg-violet-950/20 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name">
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            aria-label="Derived channel name"
            className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
          />
        </Field>
        <span className="pb-1 text-zinc-500">=</span>
        <Field label="A">
          <ChannelSelect value={aId} onChange={setA} meters={meters} />
        </Field>
        <Field label="Op">
          <select
            value={op}
            onChange={e => setOp(e.target.value as DerivedOp)}
            aria-label="Operation"
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
          >
            {OPS.map(o => (
              <option key={o} value={o}>
                {OP_SYMBOL[o]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="B">
          <ChannelSelect value={bId} onChange={setB} meters={meters} exclude={aId} />
        </Field>
      </div>

      <div className="text-xs text-zinc-400">
        {preview.ok ? (
          <>
            Result: <span className="font-mono text-zinc-200">{aRole}</span> {OP_SYMBOL[op]}{' '}
            <span className="font-mono text-zinc-200">{bRole}</span> →{' '}
            <span className="font-semibold text-violet-300">{preview.unit || 'ratio'}</span>
          </>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">
            Can’t {op === 'add' ? 'add' : 'subtract'} {aUnit || '?'} and {bUnit || '?'} — units must
            match.
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={add}
          disabled={!preview.ok}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-violet-50 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-500">
      {label}
      {children}
    </label>
  );
}

function ChannelSelect({
  value,
  onChange,
  meters,
  exclude,
}: {
  value: string;
  onChange: (id: string) => void;
  meters: Meters;
  exclude?: string; // hide this channel (so B can't be the same channel as A)
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="Input channel"
      className="max-w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
    >
      {meters.meters
        .filter(m => m.id !== exclude)
        .map(m => (
          <option key={m.id} value={m.id}>
            {m.role}
            {m.reading?.baseUnit ? ` (${m.reading.baseUnit})` : ''}
          </option>
        ))}
    </select>
  );
}
