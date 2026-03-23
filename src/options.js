const DEFAULTS = {
  intervalSeconds: 5,
  timeoutMs: 8000,
  backoffMaxSeconds: 60,
  afterCloseMode: 'intl',
  closedIntervalSeconds: 60,
  displayMode: 'hover',
};

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const cfg = res?.ok ? res.config : DEFAULTS;
  document.getElementById('intervalSeconds').value = String(cfg.intervalSeconds ?? DEFAULTS.intervalSeconds);
  document.getElementById('timeoutMs').value = String(cfg.timeoutMs ?? DEFAULTS.timeoutMs);
  document.getElementById('backoffMaxSeconds').value = String(cfg.backoffMaxSeconds ?? DEFAULTS.backoffMaxSeconds);
  document.getElementById('afterCloseMode').value = String(cfg.afterCloseMode ?? DEFAULTS.afterCloseMode);
  document.getElementById('closedIntervalSeconds').value = String(cfg.closedIntervalSeconds ?? DEFAULTS.closedIntervalSeconds);
  document.getElementById('displayMode').value = String(cfg.displayMode ?? DEFAULTS.displayMode);
}

async function save() {
  const intervalSeconds = Number(document.getElementById('intervalSeconds').value);
  const timeoutMs = Number(document.getElementById('timeoutMs').value);
  const backoffMaxSeconds = Number(document.getElementById('backoffMaxSeconds').value);
  const afterCloseMode = String(document.getElementById('afterCloseMode').value || DEFAULTS.afterCloseMode);
  const closedIntervalSeconds = Number(document.getElementById('closedIntervalSeconds').value);
  const displayMode = String(document.getElementById('displayMode').value || DEFAULTS.displayMode);

  await chrome.runtime.sendMessage({
    type: 'SET_CONFIG',
    patch: {
      intervalSeconds: Math.max(1, Math.floor(intervalSeconds || DEFAULTS.intervalSeconds)),
      timeoutMs: Math.max(1000, Math.floor(timeoutMs || DEFAULTS.timeoutMs)),
      backoffMaxSeconds: Math.max(5, Math.floor(backoffMaxSeconds || DEFAULTS.backoffMaxSeconds)),
      afterCloseMode,
      closedIntervalSeconds: Math.max(10, Math.floor(closedIntervalSeconds || DEFAULTS.closedIntervalSeconds)),
      displayMode,
    },
  });

  // Ask offscreen loop to re-read config ASAP.
  try {
    await chrome.runtime.sendMessage({ type: 'PING' });
  } catch {}

  const el = document.getElementById('saved');
  el.style.display = '';
  setTimeout(() => (el.style.display = 'none'), 1200);
}

document.getElementById('save').addEventListener('click', () => void save());
void load();
