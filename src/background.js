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

  // How to display price on the toolbar:
  // - hover: hide badge text, show full info in tooltip on hover
  // - badge: show short price in badge
  displayMode: 'hover',
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

function isReasonableCnyPerGram(v) {
  // Guardrail to avoid crazy spikes from bad data.
  // Gold in CNY/g is typically in the 300~1000 range historically.
  return typeof v === 'number' && Number.isFinite(v) && v >= 100 && v <= 2000;
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

function pickSgeLatestPrice(j) {
  // SGE returns a full session minute-series; future minutes may be filled with the previous close.
  // So using the last element is WRONG during the session.
  // We must select the data point corresponding to `delaystr` (last update time).
  const times = j?.times;
  const data = j?.data;
  const delaystr = j?.delaystr;

  let pointTime;
  const m = String(delaystr || '').match(/(\d{2}):(\d{2}):(\d{2})/);
  if (m) pointTime = `${m[1]}:${m[2]}`;

  if (pointTime && Array.isArray(times) && Array.isArray(data)) {
    const idx = times.lastIndexOf(pointTime);
    if (idx >= 0 && idx < data.length) {
      const v = Number(data[idx]);
      if (Number.isFinite(v) && v > 0) {
        return { price: v, pointTime };
      }
    }
  }

  return { price: lastNonZero(data), pointTime: undefined };
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
  const updateText = j.delaystr || '';
  const updateAt = parseSgeDelayStr(updateText);
  const picked = pickSgeLatestPrice(j);
  const price = picked.price;
  const extra = picked.pointTime ? ` (point ${picked.pointTime})` : '';
  return { price, updateText: updateText + extra, updateAt };
}

function parseStooqRow(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const row = lines[1].split(',').map((s) => s.trim());
  const idxClose = header.indexOf('close');
  const idxDate = header.indexOf('date');
  const idxTime = header.indexOf('time');
  if (idxClose < 0) return undefined;
  const close = Number(row[idxClose]);
  if (!Number.isFinite(close)) return undefined;
  const date = idxDate >= 0 ? row[idxDate] : '';
  const time = idxTime >= 0 ? row[idxTime] : '';
  const tsText = [date, time].filter(Boolean).join(' ');
  return { close, tsText };
}

function tzOffsetMinutes(date, timeZone) {
  // Returns timezone offset in minutes for a given Date.
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

function parseZonedDateTimeToUtcMs(tsText, timeZone) {
  // tsText: "YYYY-MM-DD HH:MM:SS" interpreted in `timeZone`.
  const m = String(tsText).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [_, yy, mo, dd, hh, mm, ss] = m;
  const baseUtc = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mm), Number(ss));
  // One-step correction using timezone offset at the guessed moment.
  const offMin = tzOffsetMinutes(new Date(baseUtc), timeZone);
  return baseUtc - offMin * 60000;
}

function formatInTz(date, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatStooqTsToLocal(tsText) {
  // Convert Stooq timestamp into the browser's local timezone for display.
  // Stooq is Poland-based; their timestamps typically align with Europe/Warsaw.
  if (!tsText) return '';
  const warsawTz = 'Europe/Warsaw';
  const utcMs = parseZonedDateTimeToUtcMs(tsText, warsawTz);
  if (utcMs == null) return tsText;
  // Intl without explicit timeZone => browser local time.
  return new Intl.DateTimeFormat(undefined, {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(utcMs));
}

async function fetchIntlApprox(cfg) {
  // International approx (near-real-time): use XAUUSD×USDCNY only.
  // NOTE: Stooq's XAUCNY is sometimes inconsistent vs cross rate; avoid it to prevent spikes.
  const OZ_TO_GRAM = 31.1034768;

  const xauUrl = 'https://stooq.com/q/l/?s=xauusd&f=sd2t2c&h&e=csv&t=' + Date.now();
  const fxUrl = 'https://stooq.com/q/l/?s=usdcny&f=sd2t2c&h&e=csv&t=' + Date.now();

  const [xauCsv, fxCsv] = await Promise.all([
    fetchText(xauUrl, { headers: { Accept: 'text/csv,*/*' } }, cfg.timeoutMs),
    fetchText(fxUrl, { headers: { Accept: 'text/csv,*/*' } }, cfg.timeoutMs),
  ]);

  const xau = parseStooqRow(xauCsv);
  const fx = parseStooqRow(fxCsv);
  if (!xau || !fx) return undefined;

  return {
    cnyPerGram: (xau.close * fx.close) / OZ_TO_GRAM,
    sourceText: 'Stooq XAUUSD×USDCNY',
    tsText: xau.tsText || fx.tsText,
  };
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

  if (msg?.type === 'PING') {
    // No-op; used to nudge offscreen to reload config sooner.
    sendResponse({ ok: true });
    return;
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
      let usedFallback = false;

      // keep last good value to avoid spikes
      const state = await chrome.storage.local.get(['lastGoodPrice', 'lastGoodUpdate']);
      const lastGoodPrice = typeof state.lastGoodPrice === 'number' ? state.lastGoodPrice : undefined;

      if ((price == null || stale) && cfg.afterCloseMode === 'intl') {
        const intl = await fetchIntlApprox(cfg).catch(() => undefined);
        if (intl?.cnyPerGram != null && isReasonableCnyPerGram(intl.cnyPerGram)) {
          price = intl.cnyPerGram;
          update = `${intl.sourceText}${intl.tsText ? ` @ ${formatStooqTsToLocal(intl.tsText)}` : ''}  ${sge.updateText || ''}`.trim();
          usedFallback = true;
        } else if (lastGoodPrice != null) {
          // Bad fallback data; hold last known good value.
          price = lastGoodPrice;
          update = `Hold last value (bad fallback)  ${sge.updateText || ''}`.trim();
          usedFallback = true;
        }
      }

      // persist last good
      if (price != null && isReasonableCnyPerGram(price)) {
        await chrome.storage.local.set({ lastGoodPrice: price, lastGoodUpdate: update || '' });
      }

      // 3) Tell offscreen how often to poll
      const effectiveIntervalSeconds = stale ? Math.max(10, Number(cfg.closedIntervalSeconds) || 60) : Math.max(1, cfg.intervalSeconds);

      // 4) Apply display mode at the source of truth (service worker)
      const displayMode = cfg.displayMode || 'hover';
      const badgeText = displayMode === 'badge' && price != null ? (price >= 1000 ? String(Math.round(price)) : price.toFixed(1)) : '';
      const badgeBg = usedFallback ? '#1565C0' : '#2E7D32';
      const tooltipLines = [`${cfg.instid}: ${price != null ? price.toFixed(2) : '--'} ¥/g`];
      if (update) tooltipLines.push(String(update));
      if (usedFallback) tooltipLines.push('Fallback/hold in effect');
      if (stale) tooltipLines.push('SGE closed/stale');

      await setBadge({
        text: badgeText,
        title: tooltipLines.join('\n').trim(),
        bgColor: badgeBg,
        color: '#FFFFFF',
      });

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
