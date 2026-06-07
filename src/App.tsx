// Phases 1–4. Live readout + chart + stats + recording + export, a Sessions browser,
// light/dark theme, and keyboard shortcuts. One rolling history buffer (useRecorder) feeds
// the chart and stats always; recording layers IndexedDB persistence on top (the reason
// Phases 2+3 merged). A single top bar holds status, view tabs, and global actions. Routes
// (HashRouter, see main.tsx): `/` live, `/recordings` list, `/recordings/:id` one session —
// so Back works and a session is bookmarkable.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useMeter } from './hooks/useMeter';
import { useRecorder } from './hooks/useRecorder';
import { useSessions } from './hooks/useSessions';
import { usePinSession } from './hooks/usePinSession';
import type { Reading } from './ble/types';
import { useTheme } from './hooks/useTheme';
import { useChartColor } from './hooks/useChartColor';
import { resolveStroke } from './lib/chartColors';
import { ConnectionStatus, DeviceMenu, connectionAction } from './components/ConnectionChip';
import { HeroReadout } from './components/HeroReadout';
import { CopyButton } from './components/CopyButton';
import type { LiveChartHandle } from './components/LiveChart';
import { StatsPanel } from './components/StatsPanel';
import { RecordControls } from './components/RecordControls';
import { ExportButtons } from './components/ExportButtons';
import { PinSession } from './components/PinSession';
import { ThemeToggle } from './components/ThemeToggle';
import { ChartColorPicker } from './components/ChartColorPicker';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { UnsupportedBrowser } from './components/UnsupportedBrowser';
import { exportCsv, exportPng } from './lib/exporters';

// Code-split the two uPlot-heavy views so the initial bundle (welcome / connect screen) stays
// lean: uPlot only loads once there's something to chart. LiveChart loads on connect; the whole
// Recordings view loads when its tab is first opened. Both are named exports → unwrap to default.
const LiveChart = lazy(() =>
  import('./components/LiveChart').then((m) => ({ default: m.LiveChart })),
);
const SessionsList = lazy(() =>
  import('./components/SessionsList').then((m) => ({ default: m.SessionsList })),
);
const SessionViewer = lazy(() =>
  import('./components/SessionsList').then((m) => ({ default: m.SessionViewer })),
);

export default function App() {
  const meter = useMeter();
  const recorder = useRecorder(meter.reading);
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
  // Fake HOLD (the meter ignores button commands, §PROTOCOL 2): a UI-side freeze of the hero
  // readout to a snapshot, so you can capture a value to read hands-free. The chart, stats and
  // recording keep running on the live stream underneath — only the big number is frozen.
  const [held, setHeld] = useState<Reading | null>(null);
  const chartRef = useRef<LiveChartHandle>(null);
  const announceNonce = useRef(0);
  const dark = theme === 'dark';
  const chartStroke = resolveStroke(colorKey, dark);
  // The reading the hero shows: the frozen snapshot while holding, else the live value.
  const displayReading = held ?? meter.reading;

  // Hold is a live-only convenience — release it whenever we leave the live stream so a stale
  // value can't linger across a disconnect/reconnect.
  useEffect(() => {
    if (meter.state !== 'live') setHeld(null);
  }, [meter.state]);

  // Clean the home URL: HashRouter writes '#/' for the root route, but we want the index to be
  // the bare base path (…/multimeter/), not …/multimeter/#/. An empty hash maps to '/' just like
  // '#/' does, so stripping it keeps the router in sync (it re-reads an empty hash as '/'). Deeper
  // routes (#/recordings…) are untouched. replaceState fires no hashchange/popstate → no loop.
  useEffect(() => {
    if (location.pathname === '/' && window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
  }, [location]);

  const toggleHold = () => setHeld((h) => (h ? null : meter.reading));
  const pinReading = () => {
    if (displayReading) pinSession.pin(displayReading);
  };

  // Announce the live reading to the polite live region on demand (the meter updates a few
  // Hz — far too fast to announce continuously, so it's opt-in via the `s` shortcut). The
  // alternating zero-width space forces AT to re-read even an unchanged value.
  const announceReading = () => {
    const r = displayReading;
    const text = !r
      ? 'No reading'
      : r.overload
        ? `${r.function} overload`
        : `${r.function} ${r.displayText || 'no value'} ${r.displayUnit}`.trim();
    setAnnouncement(text + '\u200B'.repeat(announceNonce.current++ % 2));
  };

  // Global keyboard shortcuts. Bound once; a ref always points at the latest closure so we
  // see current state without re-subscribing. Ignored while typing or with a modifier held.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    switch (e.key) {
      case '?':
        setHelpOpen((h) => !h);
        break;
      case 'Escape':
        setHelpOpen(false);
        break;
      case 't':
        toggle();
        break;
      case 'c':
        connectionAction(meter)?.run();
        break;
      case 'b':
        if (meter.state === 'live') meter.toggleBacklight();
        break;
      case 'h':
        if (meter.state === 'live') toggleHold();
        break;
      case ' ': {
        // Space = pin. Let it activate a focused button/link/select normally (and not scroll
        // the page otherwise); only capture when focus isn't on another interactive control.
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
        void exportPng(chartRef.current, recorder.csvTarget?.name ?? 'ut60bt-chart');
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

  if (meter.state === 'unsupported') return <UnsupportedBrowser />;

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
      {/* Single bar on sm+; on narrow screens the tabs drop to a full-width row below so the
          status + global actions still fit the top row (HANDOFF responsive note). */}
      <header className="border-b border-zinc-800">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <ConnectionStatus meter={meter} />
          <DeviceMenu meter={meter} />

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
                displayReading ? (
                  <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4">
                    <HeroReadout reading={displayReading} held={held !== null} />
                    <div className="-mt-2 flex items-center justify-center gap-2">
                      <CopyButton reading={displayReading} />
                      {meter.state === 'live' && (
                        <button
                          onClick={toggleHold}
                          aria-pressed={held !== null}
                          className={`rounded-md px-4 py-1.5 text-sm ${
                            held
                              ? 'bg-amber-500 font-semibold text-amber-950 hover:bg-amber-400'
                              : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {held ? 'Holding' : 'Hold'}
                        </button>
                      )}
                    </div>
                    <Suspense fallback={<ChartSkeleton />}>
                      <LiveChart
                        ref={chartRef}
                        samples={recorder.samples}
                        segment={recorder.segment}
                        truncated={recorder.truncated}
                        dark={dark}
                        strokeColor={chartStroke}
                      />
                    </Suspense>
                    <StatsPanel
                      stats={recorder.stats}
                      unit={recorder.segment?.unit ?? ''}
                      durationMs={recorder.statsDurationMs}
                      onReset={recorder.resetStats}
                    />
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
                      canPin={displayReading !== null}
                    />
                  </div>
                ) : (
                  <Placeholder meter={meter} />
                )
              }
            />
            <Route path="/recordings" element={<SessionsList sessions={sessions} />} />
            <Route
              path="/recordings/:id"
              element={<SessionViewer sessions={sessions} dark={dark} strokeColor={chartStroke} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {meter.error && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {meter.error}
        </div>
      )}

      <footer className="border-t border-zinc-800 px-4 py-3 text-center text-xs text-zinc-500">
        <a
          href="https://github.com/mbtech-nl/multimeter"
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

      {/* Polite live region for the on-demand reading announcement (visually hidden). */}
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

// Suspense fallbacks while the code-split chunks load. The chart skeleton reserves the chart's
// height (≈ header + 280px canvas) so the dashboard doesn't jump when it swaps in.
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

function Placeholder({ meter }: { meter: ReturnType<typeof useMeter> }) {
  const { state } = meter;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-bold text-zinc-100">UT60BT</h1>
      <p className="max-w-sm text-zinc-400">
        A live, full-screen readout for your UNI-T UT60BT multimeter — with charting, recording, and
        CSV/PNG export. Power on the meter, then connect.
      </p>

      {state === 'idle' && (
        <button
          onClick={meter.connect}
          className="rounded-lg bg-emerald-500 px-6 py-3 text-lg font-semibold text-emerald-950 hover:bg-emerald-400"
        >
          Connect
        </button>
      )}

      {(state === 'connecting' || state === 'reconnecting') && (
        <p className="text-zinc-400">Pairing… choose your meter in the browser dialog.</p>
      )}

      {state === 'disconnected' && (
        <button
          onClick={meter.reconnect}
          className="rounded-lg bg-emerald-500 px-6 py-3 text-lg font-semibold text-emerald-950 hover:bg-emerald-400"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
