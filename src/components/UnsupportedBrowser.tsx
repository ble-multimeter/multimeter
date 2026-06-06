// Shown when Web Bluetooth is absent (Firefox, iOS Safari). A clear redirect, not a
// broken page (PLAN §2).
export function UnsupportedBrowser() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-bold text-zinc-100">UT60BT needs Web Bluetooth</h1>
      <p className="max-w-md text-zinc-400">
        This browser doesn't support Web Bluetooth, so it can't talk to the meter. Open this page in{' '}
        <strong className="text-zinc-200">Chrome</strong>, <strong className="text-zinc-200">Edge</strong>,
        Brave, or Opera on desktop or Android.
      </p>
      <p className="max-w-md text-sm text-zinc-500">
        On iPhone/iPad, Safari can't do Bluetooth either — the third-party{' '}
        <strong className="text-zinc-300">Bluefy</strong> browser is the usual workaround.
      </p>
    </div>
  );
}
