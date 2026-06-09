// @ble-multimeter/react — React bindings for the BLE-multimeter engines. Thin hooks over
// the framework-agnostic MeterSession / RecorderSession / SessionsStore / PinRecorder, so a
// React app gets live readout, charting data, recording, and session management with almost no
// glue. Peer-depends on react. (The Vue package mirrors this over the same engines.)

export { useMeter, type Meter, type MeterState, type MeterControl } from './useMeter';
export {
  useMeters,
  type Meters,
  type MetersSnapshot,
  type Channel,
  type MeterChannel,
  type DerivedChannel,
  type DerivedConfig,
} from './useMeters';
export { useRecorder, type Recorder, type RecState, type SegmentInfo } from './useRecorder';
export { useSessions, type Sessions, type OpenedSession, type OpenedChannel } from './useSessions';
export { usePinSession, type PinSession } from './usePinSession';
