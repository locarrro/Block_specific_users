// ============================================================
// Bilibili 黑名单增强助手 - background service worker
// 页面内的 API 调用（用户信息、视频信息、拉黑/解除、状态检查）
// 均由 content script 在页面上下文直连，这里仅保留 popup 场景
// 使用的黑名单列表读取，并以路由表分发消息。
// ============================================================

// 消息路由表：type -> handler(request, sender) => Promise<response>
const handlers = {
  getBlacklist: fetchBlacklist,
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = handlers[request.type];
  if (!handler) return; // 未知消息类型不响应
  handler(request, sender).then(sendResponse);
  return true; // 异步响应
});

// 获取黑名单列表
async function fetchBlacklist() {
  const url = 'https://api.bilibili.com/x/relation/blacks';
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('Fetch blacklist failed:', error);
    return { success: false, error: error.message };
  }
}
