// The Sessions list + read-only multi-channel viewer (PLAN §3.3, plan-7.md §6): browse persisted
// recordings, reopen one to inspect its multi-series chart + per-channel stats, re-export CSV/PNG,
// rename, or delete. Reuses MultiChart + StatsPanel so a reopened session looks like the live view.
// Derived channels were persisted as their own channel and are replayed directly (no recompute).
// These are the `/recordings` and `/recordings/:id` route components (App owns the routes).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Session } from '@ble-multimeter/protocol';
import { computeStats, toSample } from '@ble-multimeter/protocol';
import type { Sessions, OpenedChannel } from '@ble-multimeter/react';
import { MultiChart, type MultiChartHandle, type ChartSeries } from './MultiChart';
import { StatsPanel } from './StatsPanel';
import { ExportButtons } from './ExportButtons';
import { ConfirmDialog, PromptDialog } from './Dialog';
import { seriesStroke } from '../lib/chartColors';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SessionsList({ sessions }: { sessions: Sessions }) {
  const { list, refresh, remove, rename, exportCsv } = sessions;
  const navigate = useNavigate();
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
          No recordings yet. Hit ● Record on the live screen, and your sessions show up here — they
          survive a reload.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map(s => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-zinc-100">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  {fmtTime(s.startedAt)} · {s.sampleCount} samples ·{' '}
                  {(s.channels ?? []).map(c => c.label).join(', ') || '—'}
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
        onSubmit={name => renaming && rename(renaming.id, name)}
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

// A reopened channel's chart samples + stats. Derived channels carry their own persisted samples,
// so the chart is a faithful replay of what was on screen — no recompute.
function channelSeries(
  channel: OpenedChannel,
  index: number,
  colorKey: string,
  dark: boolean,
): ChartSeries {
  const last = channel.readings[channel.readings.length - 1];
  return {
    id: channel.id,
    label: channel.label,
    unit: last?.baseUnit ?? '',
    color: seriesStroke(index, colorKey, dark),
    samples: channel.readings.map((r, i) => toSample(r, i)),
  };
}

export function SessionViewer({
  sessions,
  dark,
  colorKey,
}: {
  sessions: Sessions;
  dark: boolean;
  colorKey: string;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { opened, open } = sessions;
  const ready = !!opened && opened.session.id === id;

  useEffect(() => {
    if (id && (!opened || opened.session.id !== id)) open(id);
  }, [id, opened, open]);

  const chartRef = useRef<MultiChartHandle>(null);

  const series: ChartSeries[] = useMemo(
    () => (ready ? opened!.channels.map((c, i) => channelSeries(c, i, colorKey, dark)) : []),
    [ready, opened, colorKey, dark],
  );

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
  const channels = opened!.channels;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Btn onClick={() => navigate('/recordings')}>← Back</Btn>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-100">
          {session.name}
        </h2>
        <ExportButtons chartRef={chartRef} csvTarget={{ id: session.id, name: session.name }} />
      </div>

      {channels.length === 0 ? (
        <p className="text-sm text-zinc-500">This recording has no samples.</p>
      ) : (
        <>
          <MultiChart ref={chartRef} series={series} dark={dark} />
          {channels.map((c, i) => {
            const samples = c.readings.map((r, j) => toSample(r, j));
            const stats = computeStats(samples.map(s => s.v));
            const durationMs =
              samples.length > 1 ? samples[samples.length - 1]!.t - samples[0]!.t : 0;
            const unit = c.readings[c.readings.length - 1]?.baseUnit ?? '';
            return (
              <div key={c.id} className="flex flex-col gap-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {c.label}
                  {unit ? ` · ${unit}` : ''}
                  <span
                    className="ml-2 inline-block h-2 w-2 rounded-sm align-middle"
                    style={{ backgroundColor: seriesStroke(i, colorKey, dark) }}
                    aria-hidden="true"
                  />
                </div>
                <StatsPanel stats={stats} unit={unit} durationMs={durationMs} />
              </div>
            );
          })}
        </>
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
