const themeSelector = document.getElementById('themeSelector');
const autoToggle = document.getElementById('autoToggle');
const applyHereBtn = document.getElementById('applyHereBtn');
const resetBtn = document.getElementById('resetBtn');

// 1. Initialize State
chrome.storage.local.get(['preferredTheme', 'autoMode'], (data) => {
  if (data.preferredTheme) themeSelector.value = data.preferredTheme;
  if (data.autoMode) autoToggle.checked = true;
});

// 2. Save preference and apply on selection
themeSelector.addEventListener('change', () => {
  const theme = themeSelector.value;
  savePreference(theme);
  if (theme) injectAndApply(theme);
});

// 3. Auto Mode Toggle
autoToggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => {
      if (granted) {
        chrome.storage.local.set({ autoMode: true });
      } else {
        autoToggle.checked = false;
      }
    });
  } else {
    chrome.storage.local.set({ autoMode: false });
  }
});

// 4. Apply Here
applyHereBtn.addEventListener('click', () => {
  const theme = themeSelector.value;
  if (theme) injectAndApply(theme);
});

// 5. Reset
resetBtn.addEventListener('click', () => {
  if (autoToggle.checked) {
    autoToggle.checked = false;
    chrome.storage.local.set({ autoMode: false });
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.reload(tabs[0].id);
  });
});

function injectAndApply(theme) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js']
    }, () => {
      if (chrome.runtime.lastError) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "setTheme", theme: theme });
    });
  });
}

function savePreference(theme) {
  chrome.storage.local.set({ preferredTheme: theme });
}