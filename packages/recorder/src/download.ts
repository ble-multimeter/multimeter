// Browser file-save helpers — the "take it away" half of the cause (PLAN §1). Trigger a
// download from an in-memory string or Blob without a server round-trip.

function trigger(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string, type = 'text/csv'): void {
  trigger(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  trigger(blob, filename);
}

// Filesystem-safe slug for filenames, derived from a session name.
export function slug(name: string): string {
  return (name.trim() || 'session').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}
