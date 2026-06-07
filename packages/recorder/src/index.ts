// @mbtech-nl/multimeter-recorder — browser, Bluetooth-independent recording layer for BLE
// multimeters. Framework-agnostic engines (RecorderSession live buffer + stats + segmenting +
// batched persistence; SessionsStore browse/reopen/export; PinRecorder per-item capture), the
// IndexedDB session store, and small file-download helpers. Depends only on
// @mbtech-nl/multimeter-protocol; consumed by the React/Vue bindings and the app.

export * as storage from './storage';
export { downloadText, downloadBlob, slug } from './download';
export { RecorderSession, type RecState, type SegmentInfo, type RecorderSnapshot } from './session';
export {
  SessionsStore,
  exportSessionCsv,
  type OpenedSession,
  type SessionsSnapshot,
} from './sessions';
export { PinRecorder, type PinSnapshot } from './pins';
