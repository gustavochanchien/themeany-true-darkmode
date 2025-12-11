chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    
    chrome.storage.local.get(['autoMode', 'preferredTheme'], (data) => {
      if (data.autoMode && data.preferredTheme) {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        }, () => {
          chrome.tabs.sendMessage(tabId, { 
            action: "setTheme", 
            theme: data.preferredTheme 
          });
        });
      }
    });
  }
});