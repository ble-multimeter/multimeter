// Session id generator: crypto.randomUUID where available, else a prefixed timestamp-random
// fallback. `prefix` only shows up in the fallback (stream recordings 's', pin sessions 'p').
export const newId = (prefix = 's'): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
