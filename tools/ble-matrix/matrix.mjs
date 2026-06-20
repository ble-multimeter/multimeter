#!/usr/bin/env node
// BLE matrix harness — phone-side CDP driver (one profile per invocation).
//
// Drives the web app running in Chrome on an adb-connected Android phone, over the Chrome
// DevTools Protocol, and asserts that one driver connects and decodes against a `fakemeter`
// peripheral (the sibling PyPI emulator). It is the "central + UI" half of the loop; the
// `fakemeter` peripheral half runs in YOUR terminal (it needs the real BlueZ adapter). run.sh
// orchestrates both halves across all 11 profiles.
//
// What it does, per run:
//   1. attach to the app's page target (via the forwarded devtools socket)
//   2. navigate (fresh) and wait for the dev hook window.__bleMatrix to appear
//   3. click Connect with a synthetic user gesture (requestDevice needs transient activation)
//   4. auto-accept the Web Bluetooth chooser via the CDP DeviceAccess domain, picking the
//      device whose advertised name matches --name (the fakemeter default, e.g. UT60BT-FAKE)
//   5. poll the snapshot until state==='live' with a non-null reading (or timeout)
//   6. assert the matched driverId === --driver  (catches FFF0-family mis-sniffs)
//   7. disconnect, print a JSON result line, exit 0 (pass) / 1 (fail)
//
// Zero npm deps — uses Node's built-in WebSocket + fetch (Node >=22).
//
// Usage:
//   node matrix.mjs --driver uni-t --name UT60BT-FAKE \
//     --url http://localhost:5173/multimeter/ --port 9222 --timeout 15000
//
// Prereqs (run.sh sets these up): the phone has the app open in Chrome, with
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
// pointing --port at the phone's devtools, and the app reachable at --url (adb reverse).

const args = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    args[k] = i + 1 < a.length && !a[i + 1].startsWith('--') ? a[++i] : true;
  }
}

const DRIVER = args.driver; // expected matched driver id (== fakemeter profile id)
const NAME = args.name; // advertised name to pick in the chooser (fakemeter default_name)
const URL = args.url || 'http://localhost:5173/multimeter/';
const PORT = Number(args.port || 9222);
const TIMEOUT = Number(args.timeout || 15000);
const HOST = args.host || '127.0.0.1';

if (!DRIVER || !NAME) {
  console.error('usage: matrix.mjs --driver <id> --name <FAKE-NAME> [--url ..] [--port ..]');
  process.exit(2);
}

const fail = (reason, extra = {}) => {
  console.log(JSON.stringify({ driver: DRIVER, pass: false, reason, ...extra }));
  process.exit(1);
};
const pass = extra => {
  console.log(JSON.stringify({ driver: DRIVER, pass: true, ...extra }));
  process.exit(0);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- tiny CDP client over a single page target's websocket -----------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
}

const openWs = url =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener('error', e => {
      clearTimeout(t);
      reject(new Error(`ws error: ${e.message ?? e}`));
    });
  });

// Evaluate an expression in the page and return its JSON value (awaits promises).
async function evalJson(cdp, expression, userGesture = false) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval threw');
  return result.value;
}

async function main() {
  // Tab hygiene via the browser-level CDP. Kiwi/Chromium restores old tabs across restarts and
  // throttles/discards BACKGROUND tabs — their JS (and React effects, hence window.__bleMatrix)
  // stop running, and CDP calls on a discarded tab hang. So close every leftover page target and
  // open exactly ONE fresh, foreground tab to drive. Self-healing: each run clears the previous
  // run's tab, so they never pile up.
  const ver = await fetch(`http://${HOST}:${PORT}/json/version`).then(r => r.json());
  const browser = new CDP(await openWs(ver.webSocketDebuggerUrl));
  const { targetInfos } = await browser.send('Target.getTargets');
  for (const t of targetInfos.filter(t => t.type === 'page')) {
    await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  }
  const sep = URL.includes('?') ? '&' : '?';
  const { targetId } = await browser.send('Target.createTarget', {
    url: `${URL}${sep}t=${Date.now()}`,
  });
  await browser.send('Target.activateTarget', { targetId }).catch(() => {}); // foreground = un-throttled
  await sleep(800); // let the new target publish its devtools ws endpoint

  const target = (await fetch(`http://${HOST}:${PORT}/json`).then(r => r.json())).find(
    t => t.id === targetId && t.webSocketDebuggerUrl,
  );
  if (!target) fail('could not open a fresh app tab on the phone (Target.createTarget)');

  const ws = await openWs(target.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DeviceAccess.enable');

  // Auto-accept the Web Bluetooth chooser. The scan fires deviceRequestPrompted immediately with
  // an (often empty) list and RE-fires as devices are discovered, so we must NOT cancel on the
  // first empty event — keep the prompt open, accumulate names across events, and selectPrompt as
  // soon as our fake's name appears. Cancel only at the very end if it never showed.
  let chooserSawDevices = new Set();
  let promptId = null;
  let picked = false;
  cdp.on('DeviceAccess.deviceRequestPrompted', async ev => {
    promptId = ev.id;
    for (const d of ev.devices) chooserSawDevices.add(d.name || '(unnamed)');
    if (picked) return;
    // Match ONLY by the expected name — never blind-pick "the only device", or a stray/ghost
    // advertiser (or a stale-cached name) gets selected and the app mis-routes. If the right name
    // isn't here yet, leave the prompt open; the active scan re-fires this event as it discovers.
    const dev = ev.devices.find(d => (d.name || '').includes(NAME));
    if (dev) {
      picked = true;
      await cdp.send('DeviceAccess.selectPrompt', { id: ev.id, deviceId: dev.id });
    }
  });

  // The fresh tab was already navigated to the app by Target.createTarget — no second navigate
  // needed. Just wait for the dev hook to mount (the React effect installs it after first paint).
  const hookDeadline = Date.now() + 12000;
  while (Date.now() < hookDeadline) {
    if (await evalJson(cdp, 'typeof window.__bleMatrix === "object"')) break;
    await sleep(200);
  }
  if (!(await evalJson(cdp, 'typeof window.__bleMatrix === "object"')))
    fail(
      'window.__bleMatrix never appeared — is this a DEV build with the App hook? (not a prod/Pages build)',
    );

  // Click Connect with a real user gesture so navigator.bluetooth.requestDevice is allowed.
  await evalJson(cdp, 'window.__bleMatrix.connect(0)', /* userGesture */ true);

  // Poll the snapshot until live + decoded, or timeout.
  const deadline = Date.now() + TIMEOUT;
  let snap = null;
  while (Date.now() < deadline) {
    snap = await evalJson(cdp, 'window.__bleMatrix.meters()[0]');
    if (snap?.state === 'live' && snap?.reading != null) break;
    if (snap?.state === 'error') break;
    await sleep(250);
  }

  const reading = snap?.reading ?? null;
  const result = {
    state: snap?.state ?? null,
    driverId: snap?.driverId ?? null,
    deviceName: snap?.deviceName ?? null,
    display: reading
      ? `${reading.displayText ?? reading.displayValue ?? ''} ${reading.displayUnit ?? ''}`.trim()
      : null,
    chooserSaw: [...chooserSawDevices],
  };

  // Close a still-open chooser (device never appeared) so it doesn't leak into the next run.
  if (!picked && promptId != null) {
    try {
      await cdp.send('DeviceAccess.cancelPrompt', { id: promptId });
    } catch {
      /* already gone */
    }
  }
  try {
    await evalJson(cdp, 'window.__bleMatrix.disconnect(0)');
  } catch {
    /* best effort */
  }

  if (result.state !== 'live') fail(`never went live (state=${result.state})`, result);
  if (reading == null) fail('connected but no reading decoded', result);
  if (result.driverId !== DRIVER)
    fail(`wrong driver matched: got ${result.driverId}, expected ${DRIVER}`, result);
  pass(result);
}

main().catch(e => fail(`harness error: ${e.message}`));
