const SCRIPT_ID = 'themeany-auto';

// Auto mode used to inject on tabs.onUpdated at status === 'complete', i.e. after the
// fully-lit page had already painted. A registered script at document_start paints the
// root dark before first paint instead, which removes the white flash.
async function syncAutoInjection() {
  try {
    const { autoMode } = await chrome.storage.local.get('autoMode');
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const shouldRun = Boolean(autoMode) && granted;

    // Deliberately does NOT clear autoMode when the permission is missing. The popup
    // writes autoMode before requesting (its context dies when Chrome shows the
    // permission dialog), so at this point the grant may simply still be pending —
    // clearing here would race the dialog and lose the grant.
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });

    if (shouldRun && existing.length === 0) {
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID,
        js: ['content.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true
      }]);
    } else if (!shouldRun && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
  } catch (e) {
    console.error('ThemeAny: failed to sync auto injection', e);
  }
}

// Content scripts can no longer read themes.json (it is not web-accessible any more),
// so the resolved theme object is what gets stored. Backfill it for existing installs.
async function migrateStoredTheme() {
  try {
    const { preferredTheme, preferredThemeData } = await chrome.storage.local.get([
      'preferredTheme', 'preferredThemeData'
    ]);
    if (!preferredTheme || preferredThemeData) return;

    const res = await fetch(chrome.runtime.getURL('themes.json'));
    const themes = await res.json();
    if (themes[preferredTheme]) {
      await chrome.storage.local.set({ preferredThemeData: themes[preferredTheme] });
    }
  } catch (e) {
    console.error('ThemeAny: theme migration failed', e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateStoredTheme();
  await syncAutoInjection();
});

chrome.runtime.onStartup.addListener(syncAutoInjection);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoMode' in changes) syncAutoInjection();
});

// The grant usually lands after the popup has already been torn down by the dialog,
// so this is what actually turns auto mode on the first time it is enabled.
chrome.permissions.onAdded.addListener(syncAutoInjection);

// An explicit revocation is the one case where clearing the flag is unambiguous.
chrome.permissions.onRemoved.addListener(async () => {
  try {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!granted) await chrome.storage.local.set({ autoMode: false });
  } catch (e) {
    console.error('ThemeAny: failed to handle permission removal', e);
  }
  await syncAutoInjection();
});
