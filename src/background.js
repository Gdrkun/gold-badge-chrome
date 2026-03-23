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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SET_BADGE') {
    setBadge(msg.payload)
      .then(() => sendResponse({ ok: true }))
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
