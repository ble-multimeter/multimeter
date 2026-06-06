import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phase0Capture, type CharInfo, type LogEntry } from './capture';

const RENDER_CAP = 500; // rolling window for the on-screen log; export uses full history

const DIR_STYLE: Record<LogEntry['dir'], string> = {
  rx: 'text-emerald-300',
  tx: 'text-sky-300',
  info: 'text-zinc-400',
  error: 'text-red-400',
  mark: 'text-amber-300 font-semibold',
};

export function Capture() {
  const capRef = useRef<Phase0Capture | null>(null);
  if (!capRef.current) capRef.current = new Phase0Capture();
  const cap = capRef.current;

  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gatt, setGatt] = useState<CharInfo[]>([]);
  const [dial, setDial] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cap.onStatus = setStatus;
    cap.onGatt = setGatt;
    cap.onLog = (e) => setLogs((prev) => (prev.length >= RENDER_CAP ? [...prev.slice(1), e] : [...prev, e]));
  }, [cap]);

  useEffect(() => {
    if (autoscroll) logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, autoscroll]);

  const stats = useMemo(() => {
    let measurement = 0, keepAlive = 0, unknown = 0;
    for (const e of cap.entries) {
      if (e.dir !== 'rx') continue;
      if (e.kind === 'measurement') measurement++;
      else if (e.kind === 'type-request' || e.kind === 'data-request') keepAlive++;
      else unknown++;
    }
    return { measurement, keepAlive, unknown, total: cap.entries.length };
    // recompute whenever the rolling log changes (cheap at a few Hz)
  }, [cap, logs]);

  const mark = useCallback(() => {
    cap.mark(dial.trim());
    setDial('');
  }, [cap, dial]);

  const copyFrames = useCallback(async () => {
    // Interleave dial marks with the rx frames so the dump carries dial context.
    let frames = 0;
    const lines = cap.entries
      .filter((e) => e.dir === 'mark' || (e.dir === 'rx' && !!e.hex))
      .map((e) => {
        if (e.dir === 'mark') return `\n# === MARK: ${e.source} ===`;
        frames++;
        return e.hex!;
      });
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus(`copied ${frames} rx frames + marks to clipboard`);
  }, [cap]);

  const downloadJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(cap.entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ut60bt-capture-${cap.entries.length}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [cap]);

  const supported = cap.supported;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 sm:p-6 font-mono text-sm">
      <header className="mb-4">
        <h1 className="text-lg font-bold text-zinc-50">UT60BT — Phase 0 capture tool</h1>
        <p className="text-zinc-500">
          Throwaway dev aid. Enumerates GATT, subscribes to all notify chars, runs the handshake,
          logs raw frames. Filter <code className="text-zinc-300">namePrefix: "UT60BT"</code>.
        </p>
      </header>

      {!supported && (
        <div className="mb-4 rounded border border-red-800 bg-red-950/50 p-3 text-red-300">
          Web Bluetooth is not available here. Open this in Chrome or Edge over{' '}
          <code>localhost</code> (or HTTPS).
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => cap.connect()} disabled={!supported}
          className="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-40">
          Connect
        </button>
        <button onClick={() => cap.disconnect()}
          className="rounded bg-zinc-700 px-3 py-1.5 hover:bg-zinc-600">
          Disconnect
        </button>
        <span className="mx-2 h-5 w-px bg-zinc-700" />
        <button onClick={() => cap.sendCommand('GET_NAME')} className="rounded bg-sky-700 px-2.5 py-1.5 hover:bg-sky-600">GET-NAME</button>
        <button onClick={() => cap.sendCommand('GET_DATA')} className="rounded bg-sky-700 px-2.5 py-1.5 hover:bg-sky-600">GET-DATA</button>
        <button onClick={() => cap.sendCommand('BACKLIGHT')} className="rounded bg-sky-700 px-2.5 py-1.5 hover:bg-sky-600">BACKLIGHT</button>
      </div>

      {/* Dial marker */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input value={dial} onChange={(e) => setDial(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && mark()}
          placeholder="dial position (e.g. 'DCV 20V')"
          className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 placeholder:text-zinc-600" />
        <button onClick={mark} className="rounded bg-amber-600 px-3 py-1.5 font-semibold text-zinc-950 hover:bg-amber-500">
          Mark dial
        </button>
        <span className="text-zinc-500">— stamp the log before each knob turn so codes map to positions</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div>
          status: <span className="text-zinc-50">{status}</span>
        </div>
        <div className="text-zinc-400">
          rx frames — meas <span className="text-emerald-300">{stats.measurement}</span>
          {' · '}keep-alive <span className="text-sky-300">{stats.keepAlive}</span>
          {' · '}unknown <span className="text-red-300">{stats.unknown}</span>
          {' · '}log {stats.total}
        </div>
        <span className="mx-1 h-5 w-px bg-zinc-700" />
        <button onClick={copyFrames} className="rounded bg-zinc-700 px-2.5 py-1 hover:bg-zinc-600">Copy RX frames</button>
        <button onClick={downloadJson} className="rounded bg-zinc-700 px-2.5 py-1 hover:bg-zinc-600">Download JSON</button>
        <label className="flex items-center gap-1.5 text-zinc-400">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          autoscroll
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        {/* GATT table */}
        <section className="rounded border border-zinc-800 bg-zinc-900/40 p-3 max-h-[70vh] overflow-auto">
          <h2 className="mb-2 font-bold text-zinc-300">GATT table ({gatt.length} chars)</h2>
          {gatt.length === 0 ? (
            <p className="text-zinc-600">Connect to enumerate.</p>
          ) : (
            <ul className="space-y-1.5">
              {gatt.map((c, i) => (
                <li key={i} className="break-all">
                  <div className="text-zinc-200">{shortUuid(c.uuid)}</div>
                  <div className="text-zinc-600 text-xs">svc {shortUuid(c.service)}</div>
                  <div className="text-xs">
                    {c.properties.map((p) => (
                      <span key={p} className={`mr-1 rounded px-1 ${p === 'notify' || p === 'indicate' ? 'bg-emerald-900 text-emerald-300' : p.startsWith('write') ? 'bg-sky-900 text-sky-300' : 'bg-zinc-800 text-zinc-400'}`}>
                        {p}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Log */}
        <section className="flex flex-col rounded border border-zinc-800 bg-black/40 p-3 max-h-[70vh]">
          <h2 className="mb-2 font-bold text-zinc-300 shrink-0">Frame log {logs.length >= RENDER_CAP && <span className="text-zinc-600">(showing last {RENDER_CAP})</span>}</h2>
          <div className="space-y-0.5 flex-1 min-h-0 overflow-auto">
            {logs.map((e) => (
              <LogRow key={e.id} e={e} />
            ))}
            <div ref={logEndRef} />
          </div>
        </section>
      </div>
    </div>
  );
}

function LogRow({ e }: { e: LogEntry }) {
  const ts = new Date(e.t).toISOString().slice(11, 23);
  return (
    <div className={`flex flex-wrap gap-x-3 ${DIR_STYLE[e.dir]}`}>
      <span className="text-zinc-600">{ts}</span>
      <span className="w-10 shrink-0 uppercase">{e.dir}</span>
      {e.dir === 'rx' || e.dir === 'tx' ? (
        <>
          <span className="w-16 shrink-0 text-zinc-500">{e.dir === 'rx' ? charTag(e.source) : e.source}</span>
          <span className="text-zinc-500">{e.len}b</span>
          <span>{e.hex}</span>
          {e.decode && (
            <span className="text-zinc-400">
              → {e.decode.fnName}
              {e.decode.fnBit7 ? '(bit7!)' : ''} r{e.decode.rangeChar} "{e.decode.display}"
              {' '}A:{hex2(e.decode.flagsA)} B:{hex2(e.decode.flagsB)} C:{hex2(e.decode.flagsC)}
            </span>
          )}
          {e.kind && e.kind !== 'measurement' && <span className="text-amber-400">[{e.kind}]</span>}
        </>
      ) : (
        <span>{e.source}{e.note ? ` — ${e.note}` : ''}</span>
      )}
    </div>
  );
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function shortUuid(u: string): string {
  // collapse the 16-bit base UUID for readability
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  return m ? `0x${m[1]}` : u;
}

// Compact per-frame source tag: 0xffd1 for 16-bit chars, else the distinguishing
// 2nd UUID group (e.g. '1e4d', 'aca3') so we can see which char streamed each frame.
function charTag(u: string): string {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  if (m) return `0x${m[1]}`;
  return u.split('-')[1] ?? u;
}
