// An explicit sliding theme switch (a plain icon button read as decoration, not a control).
// role="switch" + aria-checked makes it a proper toggle for AT; it's a native <button> so
// Space/Enter work and the global focus-visible ring applies.
//
// Note: this component uses literal hex colors instead of `zinc-*` utilities on purpose.
// The app themes by mirroring the zinc ramp (see index.css), which would flip a track
// color between themes; the switch needs a predictable light-gray track in light mode and
// a dark-gray track in dark mode, so it opts out of the ramp.

export function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={onToggle}
      className="relative inline-flex h-7 w-[3.25rem] shrink-0 cursor-pointer items-center rounded-full bg-[#d4d4d8] transition-colors dark:bg-[#3f3f46]"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-between px-1.5 text-[0.7rem] leading-none text-[#52525b] dark:text-[#d4d4d8]"
      >
        <span>☀</span>
        <span>☾</span>
      </span>
      <span
        className={`relative z-10 ml-0.5 h-6 w-6 transform rounded-full bg-white shadow transition-transform ${
          dark ? 'translate-x-[1.5rem]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
