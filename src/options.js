const DEFAULTS = {
  intervalSeconds: 5,
  timeoutMs: 8000,
  backoffMaxSeconds: 60,
};

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const cfg = res?.ok ? res.config : DEFAULTS;
  document.getElementById('intervalSeconds').value = String(cfg.intervalSeconds ?? DEFAULTS.intervalSeconds);
  document.getElementById('timeoutMs').value = String(cfg.timeoutMs ?? DEFAULTS.timeoutMs);
  document.getElementById('backoffMaxSeconds').value = String(cfg.backoffMaxSeconds ?? DEFAULTS.backoffMaxSeconds);
}

async function save() {
  const intervalSeconds = Number(document.getElementById('intervalSeconds').value);
  const timeoutMs = Number(document.getElementById('timeoutMs').value);
  const backoffMaxSeconds = Number(document.getElementById('backoffMaxSeconds').value);

  await chrome.runtime.sendMessage({
    type: 'SET_CONFIG',
    patch: {
      intervalSeconds: Math.max(1, Math.floor(intervalSeconds || DEFAULTS.intervalSeconds)),
      timeoutMs: Math.max(1000, Math.floor(timeoutMs || DEFAULTS.timeoutMs)),
      backoffMaxSeconds: Math.max(5, Math.floor(backoffMaxSeconds || DEFAULTS.backoffMaxSeconds)),
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
