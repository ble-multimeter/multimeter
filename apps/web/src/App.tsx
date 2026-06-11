// Phase 7. A multi-channel dashboard: N meter channels (real or demo) + derived channels
// (P = V × I, …), charted together on one multi-series chart, with per-channel stats and one shared
// recording that spans every channel. `useMeters` owns the coordinator (per-meter sessions +
// derived recompute); `useRecorder(meters.channels)` is the shared multi-channel recorder. A single
// top bar holds global actions + view tabs. Routes (HashRouter, see main.tsx): `/` live,
// `/recordings` list, `/recordings/:id` one session.
//
// Demo (`?demo`) auto-streams; `?demo=power` preloads V + I meters + a P=V×I derived channel — the
// headline two-device scenario, exercisable without hardware.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useMeters, useRecorder, useSessions, usePinSession } from '@ble-multimeter/react';
import type { Meters, MeterChannel } from '@ble-multimeter/react';
import { useTheme } from './hooks/useTheme';
import { useChartColor } from './hooks/useChartColor';
import { seriesStroke } from './lib/chartColors';
import { MeterCard } from './components/MeterCard';
import { DerivedCard } from './components/DerivedCard';
import { DerivedBuilder } from './components/DerivedBuilder';
import { StatsPanel } from './components/StatsPanel';
import type { MultiChartHandle, ChartSeries } from './components/MultiChart';
import { RecordControls } from './components/RecordControls';
import { ExportButtons } from './components/ExportButtons';
import { PinSession } from './components/PinSession';
import { ThemeToggle } from './components/ThemeToggle';
import { ChartColorPicker } from './components/ChartColorPicker';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { UnsupportedBrowser } from './components/UnsupportedBrowser';
import { exportCsv, exportPng } from './lib/exporters';

// Code-split the uPlot-heavy chart + the whole Recordings view so the initial bundle stays lean.
const MultiChart = lazy(() =>
  import('./components/MultiChart').then(m => ({ default: m.MultiChart })),
);
const SessionsList = lazy(() =>
  import('./components/SessionsList').then(m => ({ default: m.SessionsList })),
);
const SessionViewer = lazy(() =>
  import('./components/SessionsList').then(m => ({ default: m.SessionViewer })),
);

export default function App() {
  const meters = useMeters();
  const recorder = useRecorder(meters.channels);
  const sessions = useSessions();
  const pinSession = usePinSession();
  const { theme, toggle } = useTheme();
  const { colorKey, setColorKey } = useChartColor();
  const navigate = useNavigate();
  const location = useLocation();
  const onLive = location.pathname === '/';
  const onRecordings = location.pathname.startsWith('/recordings');
  const [helpOpen, setHelpOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const chartRef = useRef<MultiChartHandle>(null);
  const announceNonce = useRef(0);
  const dark = theme === 'dark';

  // The chart series: one per recorder channel view, colored per index (channel 0 = chosen color),
  // grouped onto y-scales by unit downstream. Pull samples from the recorder (the live buffer).
  const series: ChartSeries[] = useMemo(
    () =>
      recorder.channels.map((c, i) => ({
        id: c.id,
        label: c.label,
        unit: c.segment?.unit ?? '',
        color: seriesStroke(i, colorKey, dark),
        samples: c.samples,
      })),
    [recorder.channels, colorKey, dark],
  );
  const anyTruncated = recorder.channels.some(c => c.truncated);
  const hasData = recorder.channels.some(c => c.samples.length > 0);

  // First-run welcome: not in demo, a single meter that has never connected and has no reading.
  // Show a focused "connect your first meter" invite instead of an empty card + chart + stats —
  // one meter is the common case, so don't make the user hunt for the connect control.
  const firstRun =
    !meters.isDemo && meters.meters.length === 1 && meters.meters[0]!.state === 'idle' && !hasData;

  // Card grid columns scale with the number of cards so they fill the row: 1 = full width,
  // 2 = half/half, 3+ = a 3-col grid (wraps to more rows). Cards = meters + derived channels.
  const cardCount = meters.meters.length + meters.derived.length;
  const gridCols =
    cardCount <= 1
      ? 'grid-cols-1'
      : cardCount === 2
        ? 'sm:grid-cols-2'
        : 'sm:grid-cols-2 lg:grid-cols-3';

  // Clean the home URL (HashRouter writes '#/' for root; we want the bare base path).
  useEffect(() => {
    if (location.pathname === '/' && window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
  }, [location]);

  // Pin captures the first live meter channel's reading (the primary measurement).
  const primaryReading = meters.meters.find(m => m.reading)?.reading ?? null;
  const pinReading = () => {
    if (primaryReading) pinSession.pin(primaryReading);
  };

  // Auto-pin on HOLD: when a meter's hold flag goes false→true, capture its (now frozen) reading
  // into the pin session. Driven by the decoded `hold` bit, so it fires whether HOLD was pressed in
  // the app or on the meter's own physical button — both land in the frame. One pin per engagement;
  // releasing hold re-arms it.
  const pin = pinSession.pin;
  const heldRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const live = new Set<string>();
    for (const m of meters.meters) {
      live.add(m.id);
      const held = !!m.reading?.flags.hold;
      const wasHeld = heldRef.current.get(m.id) ?? false;
      if (held && !wasHeld && m.reading) pin(m.reading);
      heldRef.current.set(m.id, held);
    }
    // Forget removed meters so a re-added channel id re-arms cleanly.
    for (const id of [...heldRef.current.keys()]) if (!live.has(id)) heldRef.current.delete(id);
  }, [meters.meters, pin]);

  // Announce the primary reading to the polite live region on demand (`s`).
  const announceReading = () => {
    const r = primaryReading;
    const text = !r
      ? 'No reading'
      : r.overload
        ? `${r.function} overload`
        : `${r.function} ${r.displayText || 'no value'} ${r.displayUnit}`.trim();
    setAnnouncement(text + '​'.repeat(announceNonce.current++ % 2));
  };

  // Global keyboard shortcuts. Bound once; a ref always points at the latest closure.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    switch (e.key) {
      case '?':
        setHelpOpen(h => !h);
        break;
      case 'Escape':
        setHelpOpen(false);
        break;
      case 't':
        toggle();
        break;
      case 'm':
        if (meters.isDemo) meters.addDemoMeter();
        else meters.addRealMeter();
        break;
      case ' ': {
        if (t && t.closest('button, a, select, [role="button"]')) return;
        e.preventDefault();
        pinReading();
        break;
      }
      case 'r':
        if (recorder.recState === 'idle') recorder.record('');
        else recorder.stop();
        break;
      case 'p':
        if (recorder.recState === 'recording') recorder.pause();
        else if (recorder.recState === 'paused') recorder.resume();
        break;
      case 'e':
        if (recorder.csvTarget) void exportCsv(recorder.csvTarget);
        break;
      case 'i':
        void exportPng(chartRef.current, recorder.csvTarget?.name ?? 'multimeter-chart');
        break;
      case 'v':
        navigate(onLive ? '/recordings' : '/');
        break;
      case 's':
        announceReading();
        break;
      default:
        return;
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Unsupported only matters for real BLE — demo still runs. If no demo and no Web Bluetooth, the
  // sole meter channel reports 'unsupported'.
  const unsupported = !meters.isDemo && meters.meters.every(m => m.state === 'unsupported');
  if (unsupported) return <UnsupportedBrowser />;

  const tabs = (className: string) => (
    <nav aria-label="Views" className={className}>
      <Tab active={onLive} onClick={() => navigate('/')}>
        Live
      </Tab>
      <Tab active={onRecordings} onClick={() => navigate('/recordings')}>
        Recordings{sessions.list.length > 0 && ` (${sessions.list.length})`}
      </Tab>
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <span className="text-sm font-semibold text-zinc-200">Multimeter</span>
          {tabs('hidden gap-1 sm:flex')}
          <div className="ml-auto flex items-center gap-2">
            <ChartColorPicker value={colorKey} onChange={setColorKey} dark={dark} />
            <ThemeToggle dark={dark} onToggle={toggle} />
            <button
              onClick={() => setHelpOpen(true)}
              aria-label="Keyboard shortcuts"
              aria-haspopup="dialog"
              className="rounded-md px-2.5 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              <span aria-hidden="true">?</span>
            </button>
          </div>
        </div>
        {tabs('flex gap-1 border-t border-zinc-800 px-2 py-1 sm:hidden')}
      </header>

      <main className="flex flex-1 flex-col">
        <Suspense fallback={<Loading label="Loading…" />}>
          <Routes>
            <Route
              path="/"
              element={
                firstRun ? (
                  <Welcome meter={meters.meters[0]!} meters={meters} />
                ) : (
                  <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-4">
                    {/* Meter + derived cards — the column count scales with the card count so a
                      single meter spans the full row (not stuffed in a corner). */}
                    <div className={`grid grid-cols-1 gap-3 ${gridCols}`}>
                      {meters.meters.map(c => (
                        <MeterCard
                          key={c.id}
                          channel={c}
                          meters={meters}
                          removable={meters.meters.length > 1}
                        />
                      ))}
                      {meters.derived.map(c => (
                        <DerivedCard key={c.id} channel={c} meters={meters} />
                      ))}
                    </div>

                    {/* Add a meter (demo adds a profiled demo meter; real fires its own gesture) */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() =>
                          meters.isDemo ? meters.addDemoMeter() : meters.addRealMeter()
                        }
                        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
                      >
                        + Add {meters.isDemo ? 'demo ' : ''}meter
                      </button>
                      <DerivedBuilder meters={meters} />
                    </div>

                    {/* Multi-series chart */}
                    {hasData ? (
                      <Suspense fallback={<ChartSkeleton />}>
                        <MultiChart
                          ref={chartRef}
                          series={series}
                          dark={dark}
                          truncated={anyTruncated}
                        />
                      </Suspense>
                    ) : (
                      <EmptyChart isDemo={meters.isDemo} />
                    )}

                    {/* Per-channel statistics */}
                    {recorder.channels.map(c => (
                      <div key={c.id} className="flex flex-col gap-1">
                        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          {c.label}
                          {c.segment?.unit ? ` · ${c.segment.unit}` : ''}
                        </div>
                        <StatsPanel
                          stats={c.stats}
                          unit={c.segment?.unit ?? ''}
                          durationMs={c.statsDurationMs}
                          onReset={recorder.resetStats}
                        />
                      </div>
                    ))}

                    <RecordControls
                      recState={recorder.recState}
                      recCount={recorder.recCount}
                      onRecord={recorder.record}
                      onPause={recorder.pause}
                      onResume={recorder.resume}
                      onStop={recorder.stop}
                    />
                    <ExportButtons chartRef={chartRef} csvTarget={recorder.csvTarget} />
                    <PinSession
                      state={pinSession}
                      onPin={pinReading}
                      canPin={primaryReading !== null}
                    />
                  </div>
                )
              }
            />
            <Route path="/recordings" element={<SessionsList sessions={sessions} />} />
            <Route
              path="/recordings/:id"
              element={<SessionViewer sessions={sessions} dark={dark} colorKey={colorKey} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {meters.meters.find(m => m.error)?.error && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {meters.meters.find(m => m.error)?.error}
        </div>
      )}

      <footer className="border-t border-zinc-800 px-4 py-3 text-center text-xs text-zinc-500">
        <a
          href="https://github.com/ble-multimeter/multimeter"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-zinc-300"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Source on GitHub
        </a>
      </footer>

      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="flex h-[308px] w-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm text-zinc-500"
      role="status"
    >
      Loading chart…
    </div>
  );
}

function EmptyChart({ isDemo }: { isDemo: boolean }) {
  return (
    <div className="flex h-[200px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 text-center text-sm text-zinc-500">
      <span>No data yet.</span>
      <span className="text-xs">
        {isDemo
          ? 'Demo meters stream automatically — values should appear momentarily.'
          : 'Connect a meter (click its status) to start charting.'}
      </span>
    </div>
  );
}

// First-run invite (non-demo, nothing connected yet): a focused, centered call to connect the
// first meter — the common single-meter case — instead of an empty card + chart + stats grid.
// Once the user connects, App leaves first-run and the full dashboard takes over.
function Welcome({ meter, meters }: { meter: MeterChannel; meters: Meters }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-bold text-zinc-100">Multimeter</h1>
      <p className="max-w-md text-zinc-400">
        A live, full-screen readout for your Bluetooth multimeter — with charting, recording, and
        CSV/PNG export. Power on the meter, then connect. You can add more meters (and derive values
        like P = V × I) once the first is live.
      </p>
      <button
        onClick={() => meters.meterSession(meter.id)?.connect()}
        className="rounded-lg bg-emerald-500 px-6 py-3 text-lg font-semibold text-emerald-950 hover:bg-emerald-400"
      >
        Connect a meter
      </button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-500"
      role="status"
    >
      {label}
    </div>
  );
}
