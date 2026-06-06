// Export the measurement so it leaves with the user (PLAN §3.2, §1 "portable data").
// CSV is full-resolution, read from IndexedDB — never the decimated chart series (§3.3) —
// so it requires an actual recording. PNG snapshots the chart canvas and is always
// available once there's something on screen. The actual work lives in lib/exporters so
// the keyboard shortcuts share it exactly.

import type { RefObject } from 'react';
import type { LiveChartHandle } from './LiveChart';
import { exportCsv, exportPng } from '../lib/exporters';

interface Props {
  chartRef: RefObject<LiveChartHandle | null>;
  // The recording to export to CSV (active or most-recent). null → nothing recorded yet.
  csvTarget: { id: string; name: string } | null;
}

const btn =
  'rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40';

export function ExportButtons({ chartRef, csvTarget }: Props) {
  return (
    <div className="flex gap-2">
      <button
        onClick={() => csvTarget && void exportCsv(csvTarget)}
        disabled={!csvTarget}
        title={csvTarget ? 'Download full-resolution CSV' : 'Record a session to enable CSV export'}
        className={btn}
      >
        Download CSV
      </button>
      <button
        onClick={() => void exportPng(chartRef.current, csvTarget?.name ?? 'ut60bt-chart')}
        className={btn}
      >
        Download PNG
      </button>
    </div>
  );
}
