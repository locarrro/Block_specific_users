// ============================================================
// Bilibili 黑名单增强助手 - background service worker
// 职责已大幅精简：页面内的 API 调用（用户信息、视频信息、
// 拉黑/解除、状态检查）均由 content script 在页面上下文直连，
// 不再需要 executeScript 注入。这里只保留 popup 场景使用的
// 黑名单列表读取（GET 请求，直连带 cookie 即可）。
// ============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 使用 return true 表示我们将异步地发送响应
  if (request.type === 'getBlacklist') {
    fetchBlacklist().then(sendResponse);
    return true;
  }
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
