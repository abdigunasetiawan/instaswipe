/**
 * InstaSwipe - Background Service Worker
 * Handles message relay between popup and content scripts
 */

// Relay messages from popup to content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If message comes from popup (no tab), relay to active tab's content script
  if (!sender.tab) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse(response);
          }
        });
      }
    });
    return true; // Keep message channel open for async response
  }

  // If message comes from content script, relay to popup
  // (popup listens via chrome.runtime.onMessage)
  return false;
});

// Handle extension install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings
    chrome.storage.local.set({
      batchSize: 100,
      delay: 3,
      logData: [],
      stats: { unliked: 0, batches: 0, selected: 0 },
    });
    console.log('InstaSwipe installed successfully');
  }
});

// Handle extension icon click - open Instagram likes page if not already there
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url.includes('instagram.com/your_activity/interactions/likes')) {
    await chrome.tabs.create({
      url: 'https://www.instagram.com/your_activity/interactions/likes',
    });
  }
});
