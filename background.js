// d:\project\user.js\Block_specific_users\background.js

// --- 核心：监听来自 Content Script 或 Popup 的消息 ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 使用 return true 表示我们将异步地发送响应
  if (request.type === 'getBlacklist') {
    fetchBlacklist().then(sendResponse);
    return true;
  }
  if (request.type === 'getUserInfo') {
    fetchUserInfo(request.uid, sender.tab ? sender.tab.id : null).then(sendResponse);
    return true;
  }
  if (request.type === 'modifyRelation') {
    modifyRelation(request.uid, request.action).then(sendResponse);
    return true;
  }
  if (request.type === 'checkBlockStatus') {
    checkBlockStatus(request.uid, sender.tab ? sender.tab.id : null).then(sendResponse);
    return true;
  }
  if (request.type === 'getVideoInfo') {
    fetchVideoInfo(request.bvid).then(sendResponse);
    return true;
  }
});

// --- API 功能函数 ---

// 1. 获取黑名单列表 (从旧的 popup.js 迁移并优化)
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

// 2. 获取用户详细信息 (新功能)
async function fetchUserInfo(uid, tabId) {
  // 查找一个活动的B站页面来注入脚本，这是最可靠的方式
  let targetTabId = tabId;
  if (!targetTabId) {
      const tabs = await chrome.tabs.query({ url: "*://*.bilibili.com/*", status: "complete" });
      if (tabs.length > 0) targetTabId = tabs[0].id;
  }

  if (!targetTabId) {
      return { success: false, error: "无法找到B站页面进行数据获取" };
  }

  try {
    // 使用 scripting.executeScript 将 fetch 操作注入到页面中执行
    const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: async (uid) => {
            const fetchSafe = async (url) => {
                try {
                    const res = await fetch(url, { credentials: 'include' });
                    if (res.ok) return await res.json();
                    return { code: res.status, message: res.statusText };
                } catch (e) {
                    return { code: -999, message: e.message || 'Network Error' };
                }
            };

            const [stats, navnum, videos] = await Promise.all([
                fetchSafe(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`),
                fetchSafe(`https://api.bilibili.com/x/space/navnum?mid=${uid}`),
                fetchSafe(`https://api.bilibili.com/x/space/arc/search?mid=${uid}&ps=50&pn=1`)
            ]);
            // 只返回原始数据，不要在这里调用外部函数
            return { stats, navnum, videos };
        },
        args: [uid]
    });

    if (!results || !results[0] || !results[0].result) {
        throw new Error("Script injection returned no result");
    }

    const { stats, navnum, videos } = results[0].result;

    if (!stats || stats.code !== 0) {
      throw new Error(`Stats API error: ${stats?.message} (code: ${stats?.code})`);
    }

    // 处理视频数量
    let videoCount = 0;
    if (navnum && navnum.code === 0 && navnum.data) {
      videoCount = navnum.data.video || 0;
    }

    let avgLengthStr = "N/A";
    let wordCloud = [];

    // 处理视频列表
    if (videos && videos.code === 0 && videos.data && videos.data.list) {
      const videoList = videos.data.list.vlist || [];
      // 如果 navnum 失败但 search 成功，可以用 search 的 count
      if (videoCount === 0 && videos.data.page) videoCount = videos.data.page.count;
      
      // 计算平均视频时长
      const totalLength = videoList.reduce((sum, video) => sum + video.length, 0);
      const avgLength = videoList.length > 0 ? Math.round(totalLength / videoList.length) : 0;
      avgLengthStr = formatDuration(avgLength); // 这里可以正常调用了

      // 生成词云数据
      const allText = videoList.map(v => `${v.title} ${v.description} ${v.tname}`).join(' ');
      wordCloud = generateWordCloud(allText).slice(0, 15); // 这里可以正常调用了
    }

    return {
      success: true,
      data: {
        uid: uid,
        follower: stats.data.follower,
        videoCount: videoCount,
        avgLength: avgLengthStr,
        wordCloud: wordCloud
      }
    };
  } catch (error) {
    console.error(`Fetch user info for UID ${uid} failed:`, error);
    return { success: false, error: error.message };
  }
}

// 3. 获取视频详情 (Tag + AI总结)
async function fetchVideoInfo(bvid) {
  try {
    // 使用 detail 接口可以同时获取 View 和 Tags
    const detailUrl = `https://api.bilibili.com/x/web-interface/view/detail?bvid=${bvid}`;
    const detailRes = await fetch(detailUrl, { credentials: 'include' });
    const detailData = await detailRes.json();
    
    if (detailData.code !== 0) throw new Error(detailData.message);

    const tags = detailData.data.Tags ? detailData.data.Tags.map(t => t.tag_name) : [];
    const cid = detailData.data.View.cid;
    const up_mid = detailData.data.View.owner.mid;
    const up_name = detailData.data.View.owner.name;
    
    let aiSummary = '';
    try {
        // 尝试获取 AI 总结
        const aiUrl = `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${bvid}&cid=${cid}&up_mid=${up_mid}`;
        const aiRes = await fetch(aiUrl, { credentials: 'include' });
        const aiData = await aiRes.json();
        if (aiData.code === 0 && aiData.data.model_result) {
            aiSummary = aiData.data.model_result.summary;
        }
    } catch (e) {
        // AI 总结可能不存在，忽略错误
    }

    return { success: true, data: { tags, aiSummary, mid: up_mid, name: up_name } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 4. 修改关注关系 (拉黑/解除)
async function modifyRelation(uid, action) {    
    // 查找一个活动的B站页面来注入脚本，这是最可靠的方式
    const tabs = await chrome.tabs.query({ url: "*://*.bilibili.com/*", status: "complete" });
    if (tabs.length === 0) {
        return { success: false, message: "需要一个打开的B站页面来执行操作。" };
    }
    const targetTabId = tabs[0].id;

    // 在后台获取 CSRF token
    const csrf = await getCsrfToken();
    if (!csrf) {
        return { success: false, message: '获取 CSRF token 失败，请确保已登录。' };
    }

    try {
        // 使用 scripting.executeScript 将 fetch 操作注入到页面中执行
        const results = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: async (uid, action, csrf) => {
                // 这段代码将在B站页面的上下文中运行
                const url = 'https://api.bilibili.com/x/relation/modify';
                const body = new URLSearchParams();
                body.append('fid', uid);
                body.append('act', action);
                body.append('re_src', '11');
                body.append('csrf', csrf);

                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body,
                        credentials: 'include'
                    });
                    const data = await response.json();
                    if (data.code === 0) {
                        return { success: true, message: '操作成功！' };
                    } else {
                        return { success: false, message: data.message || '操作失败' };
                    }
                } catch (error) {
                    return { success: false, message: `页面内请求失败: ${error.message}` };
                }
            },
            args: [uid, action, csrf] // 将参数传递给注入的函数
        });

        // 返回注入脚本的执行结果
        return results[0].result;

    } catch (error) {
        console.error('Modify relation via injection failed:', error);
        return { success: false, message: `脚本注入失败: ${error.message}` };
    }
}

// 5. 检查用户拉黑状态 (新功能)
async function checkBlockStatus(uid, tabId) {
    let targetTabId = tabId;
    if (!targetTabId) {
        const tabs = await chrome.tabs.query({ url: "*://*.bilibili.com/*", status: "complete" });
        if (tabs.length === 0) {
            return { success: false, error: "需要一个打开的B站页面来执行操作。" };
        }
        targetTabId = tabs[0].id;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: async (uid) => {
                try {
                    const response = await fetch(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`, { credentials: 'include' });
                    const data = await response.json();
                    if (data.code === 0 && data.data) {
                        // According to Bilibili API, attribute=128 means the user is in the blacklist.
                        const isBlocked = data.data.attribute === 128;
                        return { success: true, isBlocked };
                    } else {
                        // If the API fails, we can't be sure. Default to not blocked.
                        // This also handles cases where the user account is cancelled.
                        return { success: true, isBlocked: false, error: data.message };
                    }
                } catch (error) {
                    return { success: false, error: `页面内请求失败: ${error.message}` };
                }
            },
            args: [uid]
        });
        return results[0].result;
    } catch (error) {
        console.error(`Check block status for UID ${uid} failed:`, error);
        return { success: false, error: `脚本注入失败: ${error.message}` };
    }
}


// --- 辅助函数 ---

// 从 Cookie 中获取 CSRF Token
async function getCsrfToken() {
    const cookie = await chrome.cookies.get({
        url: 'https://www.bilibili.com',
        name: 'bili_jct'
    });
    return cookie ? cookie.value : null;
}

// 格式化时长（秒 -> MM:SS）
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 简单的词云生成逻辑
function generateWordCloud(text) {
  const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '们', '一个', '这个', '那个', '和', '与', '或', '但', '也', '都', '就', '【', '】', '|', '-', 'bilibili', '哔哩哔哩']);
  const wordCounts = {};
  
  // 使用正则表达式匹配中文字符和字母数字
  const words = text.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/g) || [];

  words.forEach(word => {
    if (word.length > 1 && !stopWords.has(word.toLowerCase())) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  });

  return Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .map(entry => ({ word: entry[0], count: entry[1] }));
}
