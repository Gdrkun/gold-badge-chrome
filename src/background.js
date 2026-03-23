async function setBadge({ text, title, color, bgColor }) {
  await chrome.action.setBadgeText({ text });
  if (typeof bgColor !== 'undefined') {
    await chrome.action.setBadgeBackgroundColor({ color: bgColor });
  }
  if (typeof color !== 'undefined') {
    await chrome.action.setBadgeTextColor({ color });
  }
  if (title) {
    await chrome.action.setTitle({ title });
  }
}

async function ensureOffscreen() {
  // Offscreen document runs the actual polling loop (service worker may suspend).
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Poll SGE Au99.99 periodically and update badge',
  });
}

const DEFAULTS = {
  instid: 'Au99.99',
  intervalSeconds: 5,
  timeoutMs: 8000,
  backoffMaxSeconds: 60,
  // When SGE market is closed, choose what to display.
  // - freeze: keep last SGE value (and slow down polling)
  // - intl: show international approx (XAUUSD×USDCNY -> CNY/g)
  afterCloseMode: 'intl',
  closedIntervalSeconds: 60,
};

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function parseSgeDelayStr(s) {
  // Example: 2026年03月23日 15:45:00
  if (!s) return undefined;
  const m = String(s).match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [_, yy, mo, dd, hh, mm, ss] = m;
  // Treat as Asia/Shanghai time (UTC+8)
  const utcMs = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh) - 8, Number(mm), Number(ss));
  return new Date(utcMs);
}

function isStaleShanghai(lastUpdate, now = new Date()) {
  if (!(lastUpdate instanceof Date)) return true;
  const ageMs = now.getTime() - lastUpdate.getTime();
  return ageMs > 3 * 60 * 1000; // 3 minutes
}

async function fetchText(url, init, timeoutMs) {
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

function lastNonZero(arr) {
  if (!Array.isArray(arr)) return undefined;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = Number(arr[i]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

async function fetchSgeAu9999(cfg) {
  const url = 'https://en.sge.com.cn/graph/quotations';
  const body = new URLSearchParams({ instid: cfg.instid });
  const text = await fetchText(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body,
    },
    cfg.timeoutMs,
  );
  const j = JSON.parse(text);
  const price = lastNonZero(j.data);
  const updateText = j.delaystr || '';
  const updateAt = parseSgeDelayStr(updateText);
  return { price, updateText, updateAt };
}

async function fetchIntlApprox(cfg) {
  // International approx: XAUUSD (USD/oz) × USDCNY -> CNY/oz -> CNY/g
  const OZ_TO_GRAM = 31.1034768;

  const xauUrl = 'https://stooq.com/q/l/?s=xauusd&f=sd2t2c&h&e=csv&t=' + Date.now();
  const fxUrl = 'https://stooq.com/q/l/?s=usdcny&f=sd2t2c&h&e=csv&t=' + Date.now();

  const [xauCsv, fxCsv] = await Promise.all([
    fetchText(xauUrl, { headers: { Accept: 'text/csv,*/*' } }, cfg.timeoutMs),
    fetchText(fxUrl, { headers: { Accept: 'text/csv,*/*' } }, cfg.timeoutMs),
  ]);

  const parseClose = (csv) => {
    const lines = String(csv).trim().split(/\r?\n/);
    if (lines.length < 2) return undefined;
    const cols = lines[0].split(',');
    const idx = cols.findIndex((c) => c.toLowerCase() === 'close');
    if (idx < 0) return undefined;
    const row = lines[1].split(',');
    const v = Number(row[idx]);
    return Number.isFinite(v) ? v : undefined;
  };

  const xau = parseClose(xauCsv);
  const fx = parseClose(fxCsv);
  if (xau == null || fx == null) return undefined;
  return (xau * fx) / OZ_TO_GRAM;
}

async function setConfig(patch) {
  // Only allow known keys.
  const next = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (k in patch) next[k] = patch[k];
  }
  await chrome.storage.local.set(next);
  return await getConfig();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SET_BADGE') {
    setBadge(msg.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === 'GET_CONFIG') {
    getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === 'SET_CONFIG') {
    setConfig(msg.patch || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === 'FETCH_TICK') {
    (async () => {
      const cfg = await getConfig();

      // 1) Try SGE
      let sge;
      try {
        sge = await fetchSgeAu9999(cfg);
      } catch (e) {
        sge = { price: undefined, updateText: String(e?.message || e), updateAt: undefined };
      }

      const stale = isStaleShanghai(sge.updateAt);

      // 2) Decide what to show
      let price = sge.price;
      let update = sge.updateText;

      if ((price == null || stale) && cfg.afterCloseMode === 'intl') {
        const intl = await fetchIntlApprox(cfg).catch(() => undefined);
        if (intl != null) {
          price = intl;
          update = `Intl approx (XAUUSD×USDCNY)  ${sge.updateText || ''}`.trim();
        }
      }

      // 3) Tell offscreen how often to poll
      const effectiveIntervalSeconds = stale ? Math.max(10, Number(cfg.closedIntervalSeconds) || 60) : Math.max(1, cfg.intervalSeconds);

      sendResponse({ ok: true, price, update, stale, effectiveIntervalSeconds });
    })().catch((e) => {
      sendResponse({ ok: false, error: String(e?.message || e) });
    });

    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await setBadge({ text: '...', title: 'Au99.99: initializing', bgColor: '#455A64', color: '#FFFFFF' });
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

// Optional: click to open SGE page.
chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: 'https://en.sge.com.cn/h5_data_PriceChart?pro_name=Au99.99' });
});
