const themeSelector = document.getElementById('themeSelector');
const autoToggle = document.getElementById('autoToggle');
const applyHereBtn = document.getElementById('applyHereBtn');
const resetBtn = document.getElementById('resetBtn');

let THEMES = {};

init();

async function init() {
  THEMES = await loadThemes();
  populateSelector();

  const data = await chrome.storage.local.get(['preferredTheme', 'autoMode']);
  if (data.preferredTheme && THEMES[data.preferredTheme]) {
    themeSelector.value = data.preferredTheme;
  }

  // Don't trust the stored flag on its own — the host permission can be revoked from
  // chrome://extensions, which leaves auto mode on and doing nothing.
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (data.autoMode && !granted) {
    await chrome.storage.local.set({ autoMode: false });
    autoToggle.checked = false;
  } else {
    autoToggle.checked = Boolean(data.autoMode);
  }
}

async function loadThemes() {
  try {
    const res = await fetch(chrome.runtime.getURL('themes.json'));
    return await res.json();
  } catch (e) {
    console.error('Failed to load themes.json', e);
    return {};
  }
}

// Built from themes.json so the list can't drift out of sync with the themes themselves.
function populateSelector() {
  themeSelector.querySelectorAll('optgroup').forEach(g => g.remove());

  const groups = new Map();
  Object.entries(THEMES).forEach(([key, theme]) => {
    const label = theme.type === 'light' ? 'Light Themes' : 'Dark Themes';
    if (!groups.has(label)) {
      const group = document.createElement('optgroup');
      group.label = label;
      groups.set(label, group);
      themeSelector.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = key;
    option.textContent = theme.name || key;
    groups.get(label).appendChild(option);
  });
}

themeSelector.addEventListener('change', async () => {
  const key = themeSelector.value;
  if (!key || !THEMES[key]) return;
  await savePreference(key);
  applyToActiveTab(key);
});

autoToggle.addEventListener('change', async (e) => {
  if (!e.target.checked) {
    await chrome.storage.local.set({ autoMode: false });
    return;
  }

  // Write the intent *before* requesting: Chrome's permission dialog closes the popup,
  // which destroys this context before the request resolves. The background worker
  // reconciles against the real permission state, and init() below re-checks on open,
  // so an optimistic true is corrected if the grant never happened.
  await chrome.storage.local.set({ autoMode: true });

  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!granted) {
    await chrome.storage.local.set({ autoMode: false });
    autoToggle.checked = false;
  }
});

applyHereBtn.addEventListener('click', () => {
  const key = themeSelector.value;
  if (key && THEMES[key]) applyToActiveTab(key);
});

resetBtn.addEventListener('click', async () => {
  if (autoToggle.checked) {
    autoToggle.checked = false;
    await chrome.storage.local.set({ autoMode: false });
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
});

function applyToActiveTab(key) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    // The theme object travels in the message: themes.json is no longer readable from a
    // content script, which keeps the extension ID off every page.
    const message = { action: 'setTheme', themeData: THEMES[key] };

    // Talk to the script that is already running before reaching for an injection.
    // Injecting on every switch re-ran the whole content script — and its storage read —
    // once per frame, which on an ad-heavy page is dozens of redundant runs for a change
    // the live script can apply on its own.
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (!chrome.runtime.lastError && response && response.applied) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      }, () => {
        if (chrome.runtime.lastError) return;
        chrome.tabs.sendMessage(tab.id, message, () => {
          void chrome.runtime.lastError; // frames without a listener are expected
        });
      });
    });
  });
}

function savePreference(key) {
  return chrome.storage.local.set({
    preferredTheme: key,
    preferredThemeData: THEMES[key]
  });
}
