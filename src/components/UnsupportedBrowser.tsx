// Shown when Web Bluetooth is absent (Firefox, iOS Safari). A clear redirect, not a
// broken page (PLAN §2). The demo doesn't need Bluetooth, so we still offer it here.
export function UnsupportedBrowser() {
  // Query-only link: resolves against the current path, so it just adds ?demo.
  const demoHref = `${window.location.pathname}?demo`;
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
      <a
        href={demoHref}
        className="rounded-lg bg-emerald-500 px-5 py-2.5 font-semibold text-emerald-950 hover:bg-emerald-400"
      >
        Try the demo — no meter needed
      </a>
      <a
        href="https://github.com/mbtech-nl/multimeter"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        Source on GitHub
      </a>
    </div>
  );
}
