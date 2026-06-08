// @ble-multimeter/vue — Vue composables for the BLE-multimeter engines. The same four
// hooks as @ble-multimeter/react (useMeter/useRecorder/useSessions/usePinSession) over the
// same framework-agnostic engines, returned as computed refs. Peer-depends on vue.

export { useMeter, type MeterState, type MeterControl } from './useMeter';
export { useRecorder, type RecState, type SegmentInfo } from './useRecorder';
export { useSessions, type OpenedSession } from './useSessions';
export { usePinSession } from './usePinSession';
