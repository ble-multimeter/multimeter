// The one hook the UI consumes. Orchestrates transport + framing + decode behind a
// connection state machine, runs the handshake (GET-NAME → wait → GET-DATA), answers
// keep-alive requests, and brings the stream back after a drop by re-running the *full*
// handshake — not just gatt.connect() (PLAN §4 "Key boundaries").

import { useCallback, useEffect, useRef, useState } from 'react';
import { Transport } from '../ble/transport';
import { FrameParser, COMMANDS, type FrameKind } from '../ble/protocol';
import { decode } from '../ble/decode';
import type { Reading } from '../ble/types';
import { isDemoMode, demoReading } from '../demo/fakeMeter';

export type MeterState =
  | 'unsupported' // no Web Bluetooth
  | 'idle' // never connected / disconnected by user
  | 'connecting' // chooser + handshake in flight
  | 'live' // streaming measurements
  | 'reconnecting' // re-opening after a drop
  | 'disconnected' // dropped, data kept, offer reconnect
  | 'error';

export interface Meter {
  state: MeterState;
  reading: Reading | null;
  deviceName: string | null;
  error: string | null;
  connect: () => void;
  reconnect: () => void;
  disconnect: () => void;
  toggleBacklight: () => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function useMeter(): Meter {
  // Demo never touches Bluetooth, so it must run even where Web Bluetooth is absent —
  // start 'idle' (the effect below takes it to 'live') rather than 'unsupported'.
  const [state, setState] = useState<MeterState>(
    isDemoMode() || Transport.supported ? 'idle' : 'unsupported',
  );
  const [reading, setReading] = useState<Reading | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transportRef = useRef<Transport | null>(null);
  const parserRef = useRef(new FrameParser());

  // Demo mode (`?demo`): no BLE — feed a synthetic stream at the meter's ~4 Hz so the whole
  // UI (hero, chart, stats, recording, export) can be driven and screenshotted device-free.
  useEffect(() => {
    if (!isDemoMode()) return;
    setDeviceName('UT60BT (demo)');
    setState('live');
    const start = Date.now();
    const id = setInterval(
      () => setReading(demoReading((Date.now() - start) / 1000, Date.now())),
      250,
    );
    return () => clearInterval(id);
  }, []);

  // One-shot waiters the handshake parks on, resolved when a matching frame arrives.
  // This is what lets us sequence GET-NAME → (name response) → GET-DATA → (stream)
  // off real events instead of blind timers.
  const waitersRef = useRef<{ pred: (k: FrameKind) => boolean; resolve: () => void }[]>([]);

  const waitForFrame = useCallback((pred: (k: FrameKind) => boolean, timeoutMs: number) => {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const entry = { pred, resolve: () => finish(true) };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        waitersRef.current = waitersRef.current.filter((w) => w !== entry);
        resolve(ok);
      };
      waitersRef.current.push(entry);
      setTimeout(() => finish(false), timeoutMs);
    });
  }, []);

  const handleFrames = useCallback((chunk: Uint8Array) => {
    const frames = parserRef.current.push(chunk);
    for (const f of frames) {
      if (f.kind === 'measurement') {
        setReading(decode(f.bytes, Date.now()));
        setState('live');
      } else if (f.kind === 'type-request') {
        void transportRef.current?.write(COMMANDS.GET_NAME);
      } else if (f.kind === 'data-request') {
        void transportRef.current?.write(COMMANDS.GET_DATA);
      }
      // 'control' (e.g. the name frame) carries no measurement — but still wakes the
      // handshake waiter below.
      // Wake any handshake step waiting on this kind of frame.
      for (const w of waitersRef.current.filter((w) => w.pred(f.kind))) w.resolve();
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    // Keep reading/deviceName so the UI can show last value + offer reconnect.
    setState((s) => (s === 'idle' ? s : 'disconnected'));
  }, []);

  // Event-driven handshake. The meter ignores GET-DATA if it arrives before it has
  // answered GET-NAME, so we wait for the name (control) frame first — then keep nudging
  // GET-DATA until measurement frames actually start (a lone GET-DATA can still be dropped).
  const handshake = useCallback(async () => {
    const t = transportRef.current!;
    parserRef.current.reset();

    await t.write(COMMANDS.GET_NAME);
    // Wait for the name (control) frame; fall through on timeout and try GET-DATA anyway.
    await waitForFrame((k) => k === 'control', 1500);

    for (let attempt = 0; attempt < 5; attempt++) {
      await t.write(COMMANDS.GET_DATA);
      const streaming = await waitForFrame((k) => k === 'measurement', 700);
      if (streaming) return;
    }
    throw new Error('meter did not start streaming after handshake');
  }, [waitForFrame]);

  const connect = useCallback(async () => {
    if (!Transport.supported) {
      setState('unsupported');
      return;
    }
    setError(null);
    setState('connecting');
    const t = new Transport();
    t.onChunk = handleFrames;
    t.onDisconnect = handleDisconnect;
    transportRef.current = t;
    try {
      await t.requestAndConnect();
      setDeviceName(t.deviceName ?? 'UT60BT');
      await handshake();
    } catch (e) {
      // User dismissing the chooser throws NotFoundError — that's a cancel, not a failure.
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        setState('idle');
        return;
      }
      setError(errMsg(e));
      setState('error');
    }
  }, [handleFrames, handleDisconnect, handshake]);

  const reconnect = useCallback(async () => {
    const t = transportRef.current;
    if (!t) return connect();
    setError(null);
    setState('reconnecting');
    try {
      await t.reconnect();
      await handshake();
    } catch (e) {
      setError(errMsg(e));
      setState('error');
    }
  }, [connect, handshake]);

  const disconnect = useCallback(() => {
    transportRef.current?.disconnect();
    transportRef.current = null;
    parserRef.current.reset();
    setReading(null);
    setDeviceName(null);
    setError(null);
    setState('idle');
  }, []);

  const toggleBacklight = useCallback(() => {
    void transportRef.current?.write(COMMANDS.BACKLIGHT);
  }, []);

  return {
    state,
    reading,
    deviceName,
    error,
    connect: () => void connect(),
    reconnect: () => void reconnect(),
    disconnect,
    toggleBacklight,
  };
}
