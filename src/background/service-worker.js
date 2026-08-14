async function enableActionClickToOpenPanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("Failed to configure the side panel", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void enableActionClickToOpenPanel();
});

chrome.runtime.onStartup.addListener(() => {
  void enableActionClickToOpenPanel();
});

void enableActionClickToOpenPanel();
