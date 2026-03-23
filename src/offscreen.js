// NOTE: Fetch happens in the service worker (background.js) so that we can apply
// market-close logic + optional international fallback and keep all network policy in one place.

const DEFAULTS = {
  instid: 'Au99.99',
  intervalSeconds: 5,
  timeoutMs: 8000,
  backoffMaxSeconds: 60,
};

async function getConfig() {
  // Some Chrome builds/environments may not expose storage in offscreen documents.
  // Treat the service worker as the source of truth.
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!res?.ok) return { ...DEFAULTS };
  return { ...DEFAULTS, ...(res.config || {}) };
}

function formatBadge(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return '--';
  if (price >= 1000) return String(Math.round(price));
  return price.toFixed(1);
}

async function setBadge(payload) {
  // Offscreen documents do not always have chrome.action.* available.
  // Delegate badge updates to the extension service worker.
  const res = await chrome.runtime.sendMessage({ type: 'SET_BADGE', payload });
  if (!res?.ok) throw new Error(res?.error || 'SET_BADGE failed');
}

let stopped = false;
let inFlight = false;
let consecutiveFailures = 0;
let currentInterval = DEFAULTS.intervalSeconds;
let loopHandle = 0;

function scheduleNext(ms) {
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = setTimeout(tickLoop, ms);
}

async function tickLoop() {
  if (stopped) return;
  if (inFlight) return;
  inFlight = true;

  const cfg = await getConfig();
  const base = Math.max(1, cfg.intervalSeconds);
  const max = Math.max(5, cfg.backoffMaxSeconds);

  try {
    const { price, effectiveIntervalSeconds } = await chrome.runtime.sendMessage({ type: 'FETCH_TICK' });
    if (price == null) throw new Error('No usable price');

    consecutiveFailures = 0;
    currentInterval = effectiveIntervalSeconds ?? base;
    // Badge + tooltip updates are handled by the service worker in FETCH_TICK.
    // Keep offscreen minimal & stable.
    void price;
  } catch (e) {
    consecutiveFailures++;
    currentInterval = Math.min(max, base * Math.pow(2, Math.max(0, consecutiveFailures - 1)));

    await setBadge({
      text: '--',
      title: `Au99.99: fetch failed (#${consecutiveFailures})\n${String(e?.message || e)}`,
      bgColor: '#B71C1C',
      color: '#FFFFFF',
    });

    // Small jitter.
    await sleep(150 + Math.floor(Math.random() * 300));
  } finally {
    inFlight = false;
    if (!stopped) scheduleNext(Math.max(1, currentInterval) * 1000);
  }
}

// Start polling immediately.
void (async () => {
  await setBadge({ text: '...', title: 'Au99.99: starting', bgColor: '#455A64', color: '#FFFFFF' });
  const cfg = await getConfig();
  currentInterval = Math.max(1, cfg.intervalSeconds);
  setTimeout(tickLoop, 200);
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  // Note: returning `true` keeps the message channel open for async sendResponse.
  (async () => {
    if (msg.type === 'FETCH') {
      sendResponse({ ok: false, error: 'FETCH is not supported in offscreen (handled by service worker)' });
      return;
    }

    if (msg.type === 'PING') {
      // Config changed; reset loop to base interval ASAP.
      consecutiveFailures = 0;
      const cfg = await getConfig();
      currentInterval = Math.max(1, cfg.intervalSeconds);
      scheduleNext(50);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'STOP') {
      stopped = true;
      if (loopHandle) clearTimeout(loopHandle);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message' });
  })();

  return true;
});
