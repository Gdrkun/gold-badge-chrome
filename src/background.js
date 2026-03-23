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
};

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
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
