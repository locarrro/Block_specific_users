// ============================================================
// Bilibili 黑名单增强助手 - content script
// 运行于 B 站页面上下文（isolated world），所有 B 站 API 请求
// 在此直连：请求自带页面 origin 与登录 cookie，不再依赖
// background 的 executeScript 注入，也无需打开额外标签页。
// ============================================================

// --- B 站 API 直连封装 ---

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

// --- 全局状态 ---

// 全局变量存储关键词
let targetKeywords = [];
let hideTooltipTimer = null; // For managing tooltip hide delay

// 初始化读取关键词
chrome.storage.local.get(['targetKeyword'], (result) => {
  if (result.targetKeyword) {
    updateKeywords(result.targetKeyword);
  }
});

// 监听关键词变化，实时生效
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.targetKeyword) {
    updateKeywords(changes.targetKeyword.newValue);
    findAndProcessVideoCards(document.body);
  }
});

// 辅助函数：处理关键词字符串转数组
function updateKeywords(keywordString) {
  if (!keywordString) {
    targetKeywords = [];
    return;
  }
  // 支持中文逗号和英文逗号分隔，去重并去除空字符串
  targetKeywords = keywordString.split(/[,，]/)
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

// MutationObserver 节流：收集新增元素节点，用 requestAnimationFrame 批量处理，
// 避免高频滚动加载时对每个节点立即执行全量扫描
let pendingNodes = [];
let processScheduled = false;

function scheduleProcessing(nodes) {
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(node);
  }
  if (processScheduled) return;
  processScheduled = true;
  requestAnimationFrame(() => {
    processScheduled = false;
    const batch = pendingNodes;
    pendingNodes = [];
    for (const node of batch) {
      findAndProcessUsernames(node);
      findAndProcessVideoCards(node);
    }
  });
}

// 使用 MutationObserver 监视整个文档的动态变化（例如，评论的加载）
const observer = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    if (mutation.addedNodes.length) {
      scheduleProcessing(mutation.addedNodes);
    }
  });
});

// 立即启动监视，处理后续动态加载的内容
observer.observe(document.body, {
  childList: true,
  subtree: true
});

// 立即对页面进行初次处理
findAndProcessUsernames(document.body);
findAndProcessVideoCards(document.body);

// 兜底：页面完全加载后再次处理，防止脚本执行过早漏掉初始异步内容
window.addEventListener('load', () => {
  findAndProcessUsernames(document.body);
  findAndProcessVideoCards(document.body);
});

// 查找并处理用户名链接
function findAndProcessUsernames(container) {
  // 查找指向用户空间的链接，这是最可靠的方式
  // 扩展选择器：覆盖热门/排行榜 (.up-name a), 动态 (.bili-dyn-card-user__name) 等特定结构
  const selector = 'a[href*="space.bilibili.com"], .up-name a, .bili-dyn-card-user__name, .user-name a, .up-name__text, .bili-dyn-title__text';
  let userLinks = container.querySelectorAll ? Array.from(container.querySelectorAll(selector)) : [];

  // 修复：如果 container 本身就是目标链接 (MutationObserver 可能会直接传入该节点)
  if (container.matches && container.matches(selector)) {
    userLinks.push(container);
  }

  userLinks.forEach(link => {
    // 避免在已经处理过的元素上重复添加按钮
    if (link.dataset.blockButtonAdded) return;
    link.dataset.blockButtonAdded = 'true';

    // 排除顶栏区域 (防止对自己账号进行操作)
    if (link.closest('.bili-header, .mini-header, #international-header, .z-top-nav, .v-header')) return;

    // 优化：只在有文字内容的链接（用户名）旁显示按钮，忽略纯头像链接
    if (!link.textContent.trim()) return;

    let uid = null;
    let bvid = null;

    // 1. 尝试从 href 中提取 UID (常规情况)
    if (link.href && link.href.includes('space.bilibili.com')) {
      const match = link.href.match(/space\.bilibili\.com\/(\d+)/);
      if (match) uid = match[1];
    }

    // 2. 如果没有 UID (例如纯文本名字)，尝试从上下文卡片中获取 BVID
    if (!uid) {
      const card = link.closest('.video-card, .bili-video-card, .video-item, .small-item, .rank-item, .bili-dyn-list__item, .bili-video-card__wrap');
      if (card) {
        const vidLink = card.querySelector('a[href*="/video/BV"]');
        if (vidLink) {
          const match = vidLink.href.match(/\/video\/(BV\w+)/);
          if (match) bvid = match[1];
        }
      }
    }

    // 3. 根据获取到的信息渲染按钮
    if (uid || bvid) {
      // 如果有 UID 直接创建，如果没有 UID 但有 BVID，则创建“延迟加载”按钮
      const button = createBlockButton(uid, bvid);

      // 将按钮插入到链接元素的旁边
      link.insertAdjacentElement('afterend', button);

      // 样式修复：针对热门/排行榜等页面，父容器可能有 overflow: hidden 导致按钮不可见
      const parent = link.parentElement;
      if (parent) {
        const style = window.getComputedStyle(parent);
        if (parent.classList.contains('up-name') || style.overflow === 'hidden') {
          parent.style.overflow = 'visible';
          if (style.display === 'block') {
             parent.style.display = 'inline-flex';
             parent.style.alignItems = 'center';
          }
        }
      }

      // 添加悬停 3 秒显示用户信息功能
      setupHoverTrigger(link, uid ? 'user' : 'user-resolve', uid || bvid);
    }
  });
}

// --- 视频卡片处理：关键词屏蔽 + 悬停详情 ---

function findAndProcessVideoCards(container) {
  // 匹配常见的视频卡片选择器 (涵盖新旧版B站首页、搜索页等)
  // 新增: .small-item (每周必看), .card-item (排行榜), .bili-dyn-list__item (动态)
  const cardSelectors = '.bili-video-card, .feed-card, .video-item, .bili-video-card__wrap, .video-card, div[class*="search-all-list"] .video-item, .video-list .video-item-mixin, .rank-item, .brand-ad-list, .small-item, .card-item, .bili-dyn-list__item';
  let cards = container.querySelectorAll ? Array.from(container.querySelectorAll(cardSelectors)) : [];

  // 修复：如果 container 本身就是卡片 (MutationObserver 可能会直接传入该节点)
  if (container.matches && container.matches(cardSelectors)) {
    cards.push(container);
  }

  cards.forEach(card => {
    // 避免嵌套卡片导致的多重边框
    // 改为：如果当前卡片被包含在另一个匹配的卡片中，跳过当前卡片（只处理最外层）
    // 这样可以确保边框包裹整个卡片区域，消除“内层有框但上方有空白”的视觉问题
    if (card.parentElement && card.parentElement.closest(cardSelectors)) {
      return;
    }

    // 提取 BVID，供关键词屏蔽和悬停预览使用
    let bvid = null;
    const link = card.querySelector('a[href*="/video/BV"]');
    if (link) {
      const match = link.href.match(/\/video\/(BV\w+)/);
      if (match) bvid = match[1];
    }

    // --- 1. 关键词屏蔽逻辑 (标题 + Tags) ---
    if (!card.dataset.keywordProcessed && targetKeywords.length > 0) {
      let isBlocked = false;
      let needFetchInfo = false; // 标记是否需要请求API (用于获取Tags或缺失的UID)

      // 1a. 优先检查标题 (同步)
      // 新增: .video-name (热门), .bili-dyn-card-video__title (动态视频)
      const titleElem = card.querySelector('.bili-dyn-card-video__title, .video-name, [class*="tit"]:not(.bili-dyn-title), h3, .title');
      if (titleElem) {
        const titleText = titleElem.textContent;
        if (targetKeywords.some(keyword => titleText.includes(keyword))) {
          isBlocked = true;
        }
      }

      if (isBlocked) {
        // 如果标题匹配，但卡片上找不到UP主链接（常见于热门页），我们需要通过API获取UID才能拉黑
        const hasUserLink = !!card.querySelector('a[href*="space.bilibili.com"]');
        if (hasUserLink) {
          card.dataset.keywordProcessed = 'true';
          highlightAndOverlay(card);
        } else if (bvid) {
          // 标题匹配但无UID -> 需要请求 API 获取 UID
          needFetchInfo = true;
        }
      } else {
        // 标题不匹配 -> 需要请求 API 检查 Tags
        needFetchInfo = true;
      }

      // 1b. 发起异步请求 (获取 Tags 或 UID)
      if (needFetchInfo && bvid && !card.dataset.tagCheckInitiated) {
        card.dataset.tagCheckInitiated = 'true';
        fetchVideoInfoCached(bvid).then(res => {
          if (!card.isConnected || card.dataset.keywordProcessed) return;

          if (res && res.success) {
            const data = res.data;
            // 检查 Tags 是否匹配
            const tagMatched = data.tags && targetKeywords.some(keyword =>
              data.tags.some(tag => tag.includes(keyword))
            );

            // 如果 (标题已匹配) 或 (Tags 匹配)，则执行屏蔽
            // 注意：如果标题已匹配(isBlocked=true)，我们进入这里是为了获取 data.mid
            if (isBlocked || tagMatched) {
              card.dataset.keywordProcessed = 'true';
              // 传入 API 返回的 mid 和 name，解决页面无链接的问题
              highlightAndOverlay(card, data.mid, data.name);
            }
          }
        });
      }
    }

    // --- 2. 悬停显示视频详情逻辑 ---
    if (bvid) {
      const titleElem = card.querySelector('.bili-dyn-card-video__title, .video-name, [class*="tit"]:not(.bili-dyn-title), h3, .title');
      const cover = card.querySelector('.bili-video-card__image--link, .bili-video-card__cover, .cover, .pic, a.img-anchor') || link;
      const title = titleElem || card.querySelector('a.title');

      if (cover && !cover.dataset.hoverProcessed) {
        cover.dataset.hoverProcessed = 'true';
        setupHoverTrigger(cover, 'video', bvid);
      }
      if (title && !title.dataset.hoverProcessed) {
        title.dataset.hoverProcessed = 'true';
        setupHoverTrigger(title, 'video', bvid);
      }
    }
  });
}

function highlightAndOverlay(card, apiUid = null, apiName = null) {
  let uid = apiUid;

  // 如果没有提供 API UID，尝试从 DOM 中提取
  if (!uid) {
    const userLink = card.querySelector('a[href*="space.bilibili.com"]');
    if (userLink) {
      const match = userLink.href.match(/space\.bilibili\.com\/(\d+)/);
      if (match) uid = match[1];
    }
  }

  if (!uid) return; // 实在找不到 UID，无法拉黑，跳过

  // 1. 高亮样式
  card.classList.add('ext-keyword-highlight');

  // 创建一个独立的 div 作为边框层，以获得最高兼容性
  const borderDiv = document.createElement('div');
  borderDiv.className = 'ext-highlight-border';
  card.appendChild(borderDiv);

  // 2. 创建一个更小、更不打扰的按钮
  const btn = document.createElement('button');
  btn.className = 'ext-overlay-block-btn';
  btn.title = `检测到关键词，点击拉黑UP主 (UID: ${uid})`;
  btn.innerText = '拉黑UP';

  // 3. 绑定拉黑事件
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    btn.innerText = '...';
    modifyRelation(uid, 5).then(response => {
      if (response.success) {
        // 拉黑成功后，隐藏卡片
        card.style.display = 'none';
      } else {
        btn.innerText = '拉黑UP';
        showToast(response.message);
      }
    });
  });

  // 插入按钮
  card.appendChild(btn);
}

// 创建“拉黑”按钮
function createBlockButton(uid, bvid = null) {
  const button = document.createElement('button');
  button.innerText = '...'; // 加载状态
  button.className = 'ext-block-button';
  button.disabled = true; // 在状态确定前禁用
  if (uid) button.dataset.uid = uid;

  // 定义初始化逻辑
  const init = () => {
    // 如果没有 UID 但有 BVID，先请求 API 获取 UID
    if (!uid && bvid) {
      fetchVideoInfoCached(bvid).then(res => {
        if (res && res.success && res.data.mid) {
          uid = res.data.mid;
          button.dataset.uid = uid;
          checkStatus(); // 获取到 UID 后再检查状态
        } else {
          button.innerText = '?';
          button.title = '无法获取用户信息';
        }
      });
    } else if (uid) {
      checkStatus();
    }
  };

  // 按需检查状态
  const checkStatus = () => {
    checkBlockStatusCached(uid).then(response => {
      if (!button.isConnected) return; // 按钮可能已从 DOM 中移除

      button.disabled = false;
      if (response && response.success) {
        const isBlocked = response.isBlocked;
        button.innerText = isBlocked ? '解除' : '拉黑';
        button.dataset.blocked = isBlocked;
        if (isBlocked) {
          button.classList.add('ext-blocked');
        }
      } else {
        // 失败时，默认为“拉黑”并在悬停时显示错误
        button.innerText = '拉黑';
        button.dataset.blocked = 'false';
        button.title = '状态检查失败';
      }
    });
  };

  // 启动初始化
  init();

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!uid) return; // 防御性编程

    const isBlocked = button.dataset.blocked === 'true';
    const action = isBlocked ? 6 : 5; // 5:拉黑, 6:解除
    const actionText = isBlocked ? '解除拉黑' : '拉黑';

    button.innerText = '...';
    button.disabled = true;

    modifyRelation(uid, action).then(response => {
      button.disabled = false;
      if (response.success) {
        // 切换状态
        if (isBlocked) {
          button.innerText = '拉黑';
          button.dataset.blocked = 'false';
          button.classList.remove('ext-blocked');
        } else {
          button.innerText = '解除';
          button.dataset.blocked = 'true';
          button.classList.add('ext-blocked');
        }
      } else {
        button.innerText = isBlocked ? '解除' : '拉黑'; // 恢复文字
        showToast(response.message);
      }
    });
  });
  return button;
}

// --- 通用悬停逻辑 ---

function setupHoverTrigger(element, type, id) {
  let hoverTimer = null;

  element.addEventListener('mouseenter', () => {
    // 如果元素所在的卡片已被屏蔽/高亮，则不显示悬浮窗，避免干扰和不必要的请求
    if (element.closest('.ext-keyword-highlight')) return;

    // If a hide timer is pending, cancel it. This allows moving from username to tooltip.
    if (hideTooltipTimer) {
      clearTimeout(hideTooltipTimer);
      hideTooltipTimer = null;
    }

    // 0.5秒后触发
    hoverTimer = setTimeout(() => {
      showTooltip(element, type, id);
    }, 500);
  });

  element.addEventListener('mouseleave', () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    // Start a timer to hide the tooltip after 1 second
    hideTooltipTimer = setTimeout(() => {
        const tooltip = document.getElementById('ext-hover-tooltip');
        if (tooltip) tooltip.remove();
    }, 1000);
  });
}

// --- Tooltip 内容构建（全部走 textContent，防止 B 站可控内容注入 HTML） ---

// 清空 tooltip 并追加一个文本节点
function setTooltipText(tooltip, text, className) {
  tooltip.textContent = '';
  const div = document.createElement('div');
  if (className) div.className = className;
  div.textContent = text;
  tooltip.appendChild(div);
  return div;
}

// 轻量提示（替代 alert，避免阻塞页面且不被页面样式干扰）
function showToast(message) {
  let toast = document.getElementById('ext-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ext-toast';
    toast.className = 'ext-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('ext-toast-show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('ext-toast-show');
  }, 2500);
}

function showTooltip(targetElement, type, id) {
  // 移除旧的
  const old = document.getElementById('ext-hover-tooltip');
  if (old) old.remove();

  const tooltip = document.createElement('div');
  tooltip.id = 'ext-hover-tooltip';
  setTooltipText(tooltip, '加载中...', 'ext-loading');

  // 定位
  const rect = targetElement.getBoundingClientRect();
  tooltip.style.top = `${window.scrollY + rect.bottom + 10}px`;
  tooltip.style.left = `${window.scrollX + rect.left}px`;

  // Allow tooltip to be interactive
  tooltip.addEventListener('mouseenter', () => {
    if (hideTooltipTimer) {
      clearTimeout(hideTooltipTimer);
      hideTooltipTimer = null;
    }
  });

  tooltip.addEventListener('mouseleave', () => {
    tooltip.remove();
  });

  document.body.appendChild(tooltip);

  if (type === 'user') {
    tooltip.style.cursor = 'pointer';
    tooltip.title = '点击复制UID';
    tooltip.addEventListener('click', function handler(e) {
      e.stopPropagation();
      // Temporarily remove handler to prevent re-clicks
      tooltip.removeEventListener('click', handler);

      navigator.clipboard.writeText(id).then(() => {
        const originalChildren = Array.from(tooltip.childNodes);
        tooltip.textContent = '';
        setTooltipText(tooltip, 'UID 已复制!', 'ext-copied-message');

        setTimeout(() => {
          if (document.getElementById('ext-hover-tooltip')) {
            tooltip.textContent = '';
            originalChildren.forEach(n => tooltip.appendChild(n));
            // Re-add the handler
            tooltip.addEventListener('click', handler);
          }
        }, 1200);
      }).catch(err => {
        console.error('Failed to copy UID:', err);
        // Re-add handler on failure
        tooltip.addEventListener('click', handler);
      });
    });

    fetchUserInfoCached(id).then(res => {
      if (!document.getElementById('ext-hover-tooltip')) return;
      tooltip.textContent = '';
      if (res.success) {
        const d = res.data;
        const wc = d.wordCloud.map(w => `${w.word}`).join(' ');
        setTooltipText(tooltip, `用户详情 (UID: ${d.uid})`, 'ext-tt-title');
        setTooltipText(tooltip, `视频数: ${d.videoCount} | 粉丝: ${d.follower}`);
        setTooltipText(tooltip, `平均时长: ${d.avgLength}`);
        setTooltipText(tooltip, `词云: ${wc || '无'}`, 'ext-tt-cloud');
      } else {
        setTooltipText(tooltip, `加载失败: ${res.error}`);
      }
    });
  } else if (type === 'user-resolve') {
    // 新增：先通过 BVID 获取 UID，再显示用户信息
    setTooltipText(tooltip, '正在解析用户信息...', 'ext-loading');
    fetchVideoInfoCached(id).then(res => {
      if (res.success && res.data.mid) {
        // 获取成功，转为普通的 user 类型显示
        showTooltip(targetElement, 'user', res.data.mid);
      } else {
        setTooltipText(tooltip, '无法获取用户信息');
      }
    });
  } else if (type === 'video') {
    fetchVideoInfoCached(id).then(res => {
      if (!document.getElementById('ext-hover-tooltip')) return;
      tooltip.textContent = '';
      if (res.success) {
        const d = res.data;
        setTooltipText(tooltip, '视频详情', 'ext-tt-title');
        setTooltipText(tooltip, `Tags: ${d.tags.slice(0, 8).join(', ')}...`, 'ext-tt-tags');
        const aiDiv = document.createElement('div');
        aiDiv.className = 'ext-tt-ai';
        const strong = document.createElement('strong');
        strong.textContent = 'AI总结: ';
        aiDiv.appendChild(strong);
        aiDiv.appendChild(document.createTextNode(d.aiSummary || '暂无'));
        tooltip.appendChild(aiDiv);
      } else {
        setTooltipText(tooltip, `加载失败: ${res.error}`);
      }
    });
  }
}
