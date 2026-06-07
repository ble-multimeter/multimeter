// Export actions shared by the ExportButtons UI and the keyboard shortcuts, so both paths
// behave identically. CSV is full-resolution from IndexedDB (§3.3); PNG snapshots the
// chart canvas.
import { storage } from '@mbtech-nl/multimeter-recorder';
import { toCsv } from '@mbtech-nl/multimeter-protocol';
import { downloadText, downloadBlob, slug } from '@mbtech-nl/multimeter-recorder';

export async function exportCsv(target: { id: string; name: string }): Promise<void> {
  const readings = await storage.getReadings(target.id);
  downloadText(toCsv(readings), `${slug(target.name)}.csv`);
}

// Minimal handle so this stays in lib without importing a component type.
export interface PngSource {
  toPng: () => Promise<Blob | null>;
}

export async function exportPng(chart: PngSource | null, name: string): Promise<void> {
  const blob = await chart?.toPng();
  if (blob) downloadBlob(blob, `${slug(name)}.png`);
}
