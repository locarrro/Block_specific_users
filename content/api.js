// ============================================================
// Bilibili 黑名单增强助手 - B 站 API 直连 + TTL 缓存 + 工具函数
// 运行于 B 站页面上下文（isolated world），请求自带页面 origin
// 与登录 cookie。本文件必须最先加载（content/ui.js、content.js 依赖）。
// ============================================================

// 从页面 cookie 读取 CSRF token（bili_jct 非 HttpOnly）
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]*)/);
  return match ? match[1] : null;
}

// 带登录态的 GET 请求，返回解析后的 JSON；失败返回 { code, message }
async function apiGet(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) return await res.json();
    return { code: res.status, message: res.statusText };
  } catch (e) {
    return { code: -999, message: e.message || 'Network Error' };
  }
}

// 获取用户详细信息（粉丝数、视频数、平均时长、词云）
async function fetchUserInfo(uid) {
  const [stats, navnum, videos] = await Promise.all([
    apiGet(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`),
    apiGet(`https://api.bilibili.com/x/space/navnum?mid=${uid}`),
    apiGet(`https://api.bilibili.com/x/space/arc/search?mid=${uid}&ps=50&pn=1`)
  ]);

  if (!stats || stats.code !== 0) {
    return { success: false, error: `Stats API error: ${stats?.message} (code: ${stats?.code})` };
  }

  // 处理视频数量
  let videoCount = 0;
  if (navnum && navnum.code === 0 && navnum.data) {
    videoCount = navnum.data.video || 0;
  }

  let avgLengthStr = 'N/A';
  let wordCloud = [];

  // 处理视频列表
  if (videos && videos.code === 0 && videos.data && videos.data.list) {
    const videoList = videos.data.list.vlist || [];
    // 如果 navnum 失败但 search 成功，可以用 search 的 count
    if (videoCount === 0 && videos.data.page) videoCount = videos.data.page.count;

    // 计算平均视频时长
    const totalLength = videoList.reduce((sum, video) => sum + video.length, 0);
    const avgLength = videoList.length > 0 ? Math.round(totalLength / videoList.length) : 0;
    avgLengthStr = formatDuration(avgLength);

    // 生成词云数据
    const allText = videoList.map(v => `${v.title} ${v.description} ${v.tname}`).join(' ');
    wordCloud = generateWordCloud(allText).slice(0, 15);
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
}

// 获取视频详情（Tags + AI 总结）
async function fetchVideoInfo(bvid) {
  try {
    // 使用 detail 接口可以同时获取 View 和 Tags
    const detailData = await apiGet(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${bvid}`);
    if (detailData.code !== 0) throw new Error(detailData.message);

    const tags = detailData.data.Tags ? detailData.data.Tags.map(t => t.tag_name) : [];
    const cid = detailData.data.View.cid;
    const up_mid = detailData.data.View.owner.mid;
    const up_name = detailData.data.View.owner.name;

    let aiSummary = '';
    try {
      // 尝试获取 AI 总结
      const aiData = await apiGet(`https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${bvid}&cid=${cid}&up_mid=${up_mid}`);
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

// 修改关注关系（act=5 拉黑, act=6 解除）
async function modifyRelation(uid, action) {
  const csrf = getCsrfToken();
  if (!csrf) {
    return { success: false, message: '获取 CSRF token 失败，请确保已登录。' };
  }

  try {
    const body = new URLSearchParams();
    body.append('fid', uid);
    body.append('act', action);
    body.append('re_src', '11');
    body.append('csrf', csrf);

    const res = await fetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
      credentials: 'include'
    });
    const data = await res.json();
    if (data.code === 0) {
      return { success: true, message: '操作成功！' };
    } else {
      return { success: false, message: data.message || '操作失败' };
    }
  } catch (error) {
    return { success: false, message: `请求失败: ${error.message}` };
  }
}

// 检查用户拉黑状态（attribute=128 表示已拉黑）
async function checkBlockStatus(uid) {
  try {
    const data = await apiGet(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`);
    if (data.code === 0 && data.data) {
      // According to Bilibili API, attribute=128 means the user is in the blacklist.
      return { success: true, isBlocked: data.data.attribute === 128 };
    } else {
      // 接口失败（如账号注销）时无法确定，默认视为未拉黑
      return { success: true, isBlocked: false, error: data.message };
    }
  } catch (error) {
    return { success: false, error: `请求失败: ${error.message}` };
  }
}

// --- 辅助函数 ---

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

// --- 简单 TTL 缓存（内存级，去重并发请求；失败结果不缓存） ---

const cacheStore = new Map();

function cached(fn, ttlMs) {
  return function (...args) {
    const key = JSON.stringify(args);
    const hit = cacheStore.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.promise;

    const promise = fn.apply(this, args).then(result => {
      // 失败/未登录等结果不缓存，允许后续重试
      if (!result || result.success === false) cacheStore.delete(key);
      return result;
    });
    cacheStore.set(key, { ts: Date.now(), promise });
    return promise;
  };
}

// 用户信息 10 分钟、视频信息 10 分钟、拉黑状态 60 秒
const fetchUserInfoCached = cached(fetchUserInfo, 10 * 60 * 1000);
const fetchVideoInfoCached = cached(fetchVideoInfo, 10 * 60 * 1000);
const checkBlockStatusCached = cached(checkBlockStatus, 60 * 1000);
