const RESTRICTED_PREFIXES = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !RESTRICTED_PREFIXES.some(p => tab.url.startsWith(p))) {

    chrome.storage.local.get(['autoMode', 'preferredTheme'], (data) => {
      if (data.autoMode && data.preferredTheme) {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) return;
          chrome.tabs.sendMessage(tabId, {
            action: "setTheme",
            theme: data.preferredTheme
          });
        });
      }
    });
  }
});