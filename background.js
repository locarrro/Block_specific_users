// ============================================================
// Bilibili 黑名单增强助手 - background service worker
// 页面内的 API 调用（用户信息、视频信息、拉黑/解除、状态检查）
// 均由 content script 在页面上下文直连，这里仅保留 popup 场景
// 使用的黑名单读取 / 管理，并以路由表分发消息。
// ============================================================

// 消息路由表：type -> handler(request, sender) => Promise<response>
const handlers = {
  getBlacklist: fetchBlacklist,
  unblockUser: req => unblockUser(req.fid),
  blockUsers: req => blockUsers(req.fids),
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = handlers[request.type];
  if (!handler) return; // 未知消息类型不响应
  handler(request, sender).then(sendResponse);
  return true; // 异步响应
});

// 带登录态的 GET，返回解析后的 JSON
async function apiGet(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return response.json();
}

// 获取完整黑名单（翻页拉全量）
async function fetchBlacklist() {
  try {
    const list = [];
    const pageSize = 50;
    for (let pn = 1; pn <= 20; pn++) {
      const data = await apiGet(`https://api.bilibili.com/x/relation/blacks?pn=${pn}&ps=${pageSize}`);
      if (data.code !== 0 || !data.data || !data.data.list) {
        if (pn === 1) return { success: true, data }; // 第一页失败（-101 未登录等）原样返回
        break;
      }
      list.push(...data.data.list);
      if (!data.data.has_more || (data.data.total && list.length >= data.data.total)) break;
    }
    return { success: true, data: { code: 0, data: { list, total: list.length } } };
  } catch (error) {
    console.error('Fetch blacklist failed:', error);
    return { success: false, error: error.message };
  }
}

// 读取 CSRF token（cookie 中的 bili_jct）
async function getCsrf() {
  const cookie = await chrome.cookies.get({ url: 'https://api.bilibili.com', name: 'bili_jct' });
  return cookie ? cookie.value : null;
}

// 修改关系：act 5=拉黑 6=取消拉黑（POST + CSRF）
async function modifyRelation(fid, act) {
  try {
    const csrf = await getCsrf();
    if (!csrf) return { success: false, error: '未登录：无法获取 CSRF token（bili_jct cookie）' };
    const body = new URLSearchParams({ fid: String(fid), act: String(act), csrf });
    const response = await fetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json();
    if (data.code === 0) return { success: true };
    return { success: false, error: `${data.message} (code: ${data.code})` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 取消拉黑单个用户
async function unblockUser(fid) {
  return modifyRelation(fid, 6);
}

// 批量拉黑（JSON 导入恢复用，限并发 3）
async function blockUsers(fids) {
  const results = { ok: 0, fail: 0, errors: [] };
  const queue = [...fids];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const fid = queue.shift();
      const r = await modifyRelation(fid, 5);
      if (r.success) results.ok++;
      else {
        results.fail++;
        results.errors.push({ fid, error: r.error });
      }
    }
  });
  await Promise.all(workers);
  return { success: true, ...results };
}
