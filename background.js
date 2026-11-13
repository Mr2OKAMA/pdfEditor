const viewer = (url) =>
  chrome.runtime.getURL("viewer.html") + (url ? "?url=" + encodeURIComponent(url) : "");

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: viewer() }));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-pdf",
    title: "PDFエディタで開く",
    contexts: ["link", "page"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.pageUrl;
  if (url) chrome.tabs.create({ url: viewer(url) });
});
