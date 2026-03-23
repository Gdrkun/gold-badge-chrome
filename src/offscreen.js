async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseLastNonZero(data) {
  if (!Array.isArray(data)) return undefined;
  for (let i = data.length - 1; i >= 0; i--) {
    const v = Number(data[i]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

async function fetchAu9999(instid, timeoutMs) {
  const url = 'https://en.sge.com.cn/graph/quotations';
  const body = new URLSearchParams({ instid });

  const text = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body,
    },
    timeoutMs,
  );

  const json = JSON.parse(text);
  const price = parseLastNonZero(json.data);
  const update = json.delaystr || '';
  return { price, update };
}

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
    const { price, update } = await fetchAu9999(cfg.instid, cfg.timeoutMs);
    if (price == null) throw new Error('SGE returned no usable price');

    consecutiveFailures = 0;
    currentInterval = base;

    await setBadge({
      text: formatBadge(price),
      title: `${cfg.instid}: ${price.toFixed(2)} ¥/g\n${update}`.trim(),
      bgColor: '#2E7D32',
      color: '#FFFFFF',
    });
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
      const { instid, timeoutMs } = msg;
      try {
        const data = await fetchAu9999(instid, timeoutMs);
        sendResponse({ ok: true, ...data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
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
