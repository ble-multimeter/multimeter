// Recording controls (PLAN §3.2): the live view always shows the latest reading;
// *recording* is the explicit act of keeping it. Record / Pause / Resume / Stop, a
// session-name field, and a live sample counter.

import { useState } from 'react';
import type { RecState } from '../hooks/useRecorder';

interface Props {
  recState: RecState;
  recCount: number;
  onRecord: (name: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const btn = 'rounded-md px-3 py-1.5 text-sm font-semibold';

export function RecordControls({ recState, recCount, onRecord, onPause, onResume, onStop }: Props) {
  const [name, setName] = useState('');
  const recording = recState !== 'idle';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
      {!recording && (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onRecord(name)}
            placeholder="Session name…"
            aria-label="Session name"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500"
          />
          <button onClick={() => onRecord(name)} className={`${btn} bg-red-500 text-white hover:bg-red-400`}>
            ● Record
          </button>
        </>
      )}

      {recording && (
        <>
          <span className="flex items-center gap-2 text-sm text-zinc-300" role="status">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${
                recState === 'recording' ? 'animate-pulse bg-red-500' : 'bg-amber-400'
              }`}
            />
            {recState === 'recording' ? 'Recording' : 'Paused'}
            <span className="font-mono tabular-nums text-zinc-400">{recCount} samples</span>
          </span>

          <div className="ml-auto flex gap-2">
            {recState === 'recording' ? (
              <button onClick={onPause} className={`${btn} border border-zinc-700 text-zinc-200 hover:bg-zinc-800`}>
                Pause
              </button>
            ) : (
              <button onClick={onResume} className={`${btn} bg-emerald-500 text-emerald-950 hover:bg-emerald-400`}>
                Resume
              </button>
            )}
            <button onClick={onStop} className={`${btn} bg-zinc-200 text-zinc-900 hover:bg-white`}>
              ■ Stop
            </button>
          </div>
        </>
      )}
    </div>
  );
}
