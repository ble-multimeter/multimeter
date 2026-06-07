// The Sessions list + read-only viewer (PLAN §3.3): browse persisted recordings, reopen
// one to inspect its chart/stats, re-export CSV/PNG, rename, or delete. Reuses LiveChart
// and StatsPanel so a reopened session looks exactly like the live view. These are the
// `/recordings` and `/recordings/:id` route components (App owns the routes).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Session } from '@mbtech-nl/multimeter-protocol';
import { computeStats, splitSegments } from '@mbtech-nl/multimeter-protocol';
import type { Sessions } from '@mbtech-nl/multimeter-react';
import { LiveChart, type LiveChartHandle } from './LiveChart';
import { StatsPanel } from './StatsPanel';
import { ExportButtons } from './ExportButtons';
import { ConfirmDialog, PromptDialog } from './Dialog';

// The read-only viewer groups a recording's readings into contiguous same-quantity segments
// (PLAN §3.4) via the shared splitSegments (protocol), so a multi-mode recording is browsable
// per segment with the exact same rule the CSV export uses.

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SessionsList({ sessions }: { sessions: Sessions }) {
  const { list, refresh, remove, rename, exportCsv } = sessions;
  const navigate = useNavigate();
  // Themed dialogs replace native prompt()/confirm(); track which session each acts on.
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);

  // Refresh on entry so a just-stopped recording shows up (the route remounts on navigation).
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      <h2 className="mb-3 text-lg font-semibold text-zinc-100">Recordings</h2>
      {list.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No recordings yet. Connect, hit ● Record on the live screen, and your sessions show up
          here — they survive a reload.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-zinc-100">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  {fmtTime(s.startedAt)} · {s.sampleCount} samples ·{' '}
                  {s.segments.map((g) => g.function).join(' → ') || '—'}
                  {s.endedAt === null && <span className="ml-1 text-amber-500">· unfinished</span>}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Btn onClick={() => navigate(`/recordings/${s.id}`)}>Open</Btn>
                <Btn onClick={() => exportCsv(s)}>CSV</Btn>
                <Btn onClick={() => setRenaming(s)}>Rename</Btn>
                <Btn danger onClick={() => setDeleting(s)}>
                  Delete
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={renaming !== null}
        title="Rename recording"
        label="Name"
        initialValue={renaming?.name ?? ''}
        confirmLabel="Rename"
        onSubmit={(name) => renaming && rename(renaming.id, name)}
        onClose={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete recording"
        message={<>Delete “{deleting?.name}”? This can’t be undone.</>}
        onConfirm={() => deleting && remove(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

export function SessionViewer({
  sessions,
  dark,
  strokeColor,
}: {
  sessions: Sessions;
  dark: boolean;
  strokeColor?: string;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { opened, open } = sessions;
  const ready = !!opened && opened.session.id === id;

  // Load the bookmarked/clicked session whenever the :id doesn't match what's already open —
  // covers a fresh page load straight onto /recordings/:id as well as switching between sessions.
  useEffect(() => {
    if (id && (!opened || opened.session.id !== id)) open(id);
  }, [id, opened, open]);

  const chartRef = useRef<LiveChartHandle>(null);
  const segments = useMemo(() => (ready ? splitSegments(opened!.readings) : []), [ready, opened]);
  const [segIdx, setSegIdx] = useState(0);
  useEffect(() => setSegIdx(0), [id]); // reset to first segment when switching sessions
  const seg = segments[segIdx];

  const stats = useMemo(() => computeStats(seg ? seg.samples.map((s) => s.v) : []), [seg]);
  const durationMs =
    seg && seg.samples.length > 1 ? seg.samples[seg.samples.length - 1].t - seg.samples[0].t : 0;

  if (!ready) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
        <Btn onClick={() => navigate('/recordings')}>← Back</Btn>
        <p className="text-sm text-zinc-500" role="status">
          Loading recording…
        </p>
      </div>
    );
  }

  const session = opened!.session;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Btn onClick={() => navigate('/recordings')}>← Back</Btn>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-100">
          {session.name}
        </h2>
        <ExportButtons chartRef={chartRef} csvTarget={{ id: session.id, name: session.name }} />
      </div>

      {segments.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Recording segment">
          {segments.map((g, i) => (
            <button
              key={i}
              onClick={() => setSegIdx(i)}
              aria-pressed={i === segIdx}
              className={`rounded px-2 py-0.5 text-xs ${
                i === segIdx
                  ? 'bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500/40 dark:text-emerald-300'
                  : 'text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {g.info.function}
              {g.info.acdc ? ` ${g.info.acdc}` : ''}
            </button>
          ))}
        </div>
      )}

      {seg ? (
        <>
          <LiveChart
            ref={chartRef}
            samples={seg.samples}
            segment={seg.info}
            dark={dark}
            strokeColor={strokeColor}
          />
          <StatsPanel stats={stats} unit={seg.info.unit} durationMs={durationMs} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">This recording has no samples.</p>
      )}
    </div>
  );
}

function Btn({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs ${
        danger
          ? 'border-red-900/60 text-red-300 hover:bg-red-950/40'
          : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}
