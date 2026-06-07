// Export actions shared by the ExportButtons UI and the keyboard shortcuts, so both paths
// behave identically. CSV is the recorder package's full-resolution export (from IndexedDB,
// §3.3); PNG snapshots the chart canvas, which is app-only (uPlot).
import { exportSessionCsv, downloadBlob, slug } from '@mbtech-nl/multimeter-recorder';

export const exportCsv = exportSessionCsv;

// Minimal handle so this stays in lib without importing a component type.
export interface PngSource {
  toPng: () => Promise<Blob | null>;
}

export async function exportPng(chart: PngSource | null, name: string): Promise<void> {
  const blob = await chart?.toPng();
  if (blob) downloadBlob(blob, `${slug(name)}.png`);
}
