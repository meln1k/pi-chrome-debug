const enable = (tabId) => chrome.sidePanel.setOptions({ tabId, path: `panel.html?tab=${tabId}`, enabled: true }).catch(() => {});
const enableAll = () => void chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => t.id !== undefined && enable(t.id)));
enableAll();
chrome.runtime.onStartup.addListener(enableAll);
chrome.runtime.onInstalled.addListener(enableAll);
chrome.tabs.onActivated.addListener(({ tabId }) => void enable(tabId));
chrome.tabs.onCreated.addListener((tab) => tab.id !== undefined && enable(tab.id));
chrome.tabs.onUpdated.addListener((tabId) => void enable(tabId));
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
