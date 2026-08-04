// ============================================================
// Bilibili 黑名单增强助手 - content script 主逻辑
// 依赖先加载的 content/api.js（B 站 API 直连 + 缓存）与
// content/ui.js（拉黑按钮 / tooltip / toast）。
// 职责：关键词状态、MutationObserver 节流、DOM 扫描与卡片处理。
// ============================================================

// --- 全局状态 ---

// 全局变量存储关键词
let targetKeywords = [];

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

// 从顶栏用户入口读取当前登录用户 mid（找到即缓存；未找到不缓存以便后续重试）
let cachedMyMid = null;
function getMyMid() {
  if (cachedMyMid) return cachedMyMid;
  const link = document.querySelector('.bili-header a[href*="space.bilibili.com"], .v-header a[href*="space.bilibili.com"]');
  if (link) {
    const match = link.href.match(/space\.bilibili\.com\/(\d+)/);
    if (match) cachedMyMid = match[1];
  }
  // cookie 兜底：DedeUserID 是登录态标准字段，比顶栏 DOM 更可靠
  if (!cachedMyMid) {
    const cookie = document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
    if (cookie) cachedMyMid = cookie[1];
  }
  return cachedMyMid || null;
}

// 从页面"关注栏"DOM 提取 主播名 -> uid 映射（零请求）
function buildFollowingsMapFromDom() {
  const map = new Map();
  document.querySelectorAll('.bili-dyn-up-list__item[biliscope-userid]').forEach(item => {
    const nameEl = item.querySelector('.bili-dyn-up-list__item__name');
    const uid = item.getAttribute('biliscope-userid');
    if (nameEl && uid) map.set(nameEl.textContent.trim(), uid);
  });
  return map;
}

// 通用并发限制器：同时最多执行 max 个异步任务（降低批量请求触发风控的概率）
function createConcurrencyLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active < max && queue.length) queue.shift()();
  };
  return fn => (...args) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve(fn(...args)).then(
        v => { active--; next(); resolve(v); },
        e => { active--; next(); reject(e); }
      );
    };
    if (active < max) run();
    else queue.push(run);
  });
}
const limitedSearchUidByName = createConcurrencyLimiter(3)(searchUidByNameCached);

// 直播区主播名 -> uid：关注栏 DOM（零请求）→ 关注列表 API → 用户搜索接口
async function resolveLiveUid(name) {
  const domMap = buildFollowingsMapFromDom();
  if (domMap.has(name)) return domMap.get(name);

  const myMid = getMyMid();
  if (myMid) {
    const res = await fetchFollowingsCached(myMid);
    if (res && res.success) {
      const hit = res.list.find(u => u.uname === name);
      if (hit) return hit.mid;
    }
  }

  // 最后兜底：B 站用户搜索接口按名字解析（限并发 3）
  const searchRes = await limitedSearchUidByName(name);
  return searchRes && searchRes.success ? searchRes.uid : null;
}

// 修复父容器 overflow:hidden 导致按钮被裁剪的问题
function fixButtonOverflowParent(link) {
  const parent = link.parentElement;
  if (!parent) return;
  const style = window.getComputedStyle(parent);
  if (parent.classList.contains('up-name') || style.overflow === 'hidden') {
    parent.style.overflow = 'visible';
    if (style.display === 'block') {
      parent.style.display = 'inline-flex';
      parent.style.alignItems = 'center';
    }
  }
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

// 清理直播间"我的关注"面板内可能残留的孤儿按钮
// （Vue 虚拟滚动重渲染时会移除主播 <a> 但留下扩展插入的 <button>，累积成乱码）
document.querySelectorAll('[class*="follow-cntr"] .ext-block-button').forEach(b => b.remove());

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
  const selector = 'a[href*="space.bilibili.com"], a[href*="live.bilibili.com"], .up-name a, .bili-dyn-card-user__name, .user-name a, .up-name__text, .bili-dyn-title__text, .bili-dyn-live-users__item__uname';
  let userLinks = container.querySelectorAll ? Array.from(container.querySelectorAll(selector)) : [];

  // 修复：如果 container 本身就是目标链接 (MutationObserver 可能会直接传入该节点)
  if (container.matches && container.matches(selector)) {
    userLinks.push(container);
  }

  userLinks.forEach(link => {
    // 避免在已经处理过的元素上重复添加按钮
    if (link.dataset.blockButtonAdded) return;
    link.dataset.blockButtonAdded = 'true';

    // 排除顶栏/动态页左侧本人卡片区域 (防止对自己账号进行操作)，
    // 以及直播间"我的关注"面板 .follow-cntr（Vue 滚动列表，插入按钮会渲染异常/残留）
    if (link.closest('.bili-header, .mini-header, #international-header, .z-top-nav, .v-header, .bili-dyn-sidebar__user, [class*="my-follow"], [class*="follow-cntr"]')) return;

    // 排除"关注/粉丝/动态"统计链接（href 带子路径，非用户名）
    if (link.href && /space\.bilibili\.com\/\d+\/[\w-]+/.test(link.href)) return;

    // 优化：只在有文字内容的链接（用户名）旁显示按钮，忽略纯头像链接
    if (!link.textContent.trim()) return;

    let uid = null;
    let bvid = null;
    let roomId = null;

    // 1. 尝试从 href 中提取 UID (常规情况)
    if (link.href && link.href.includes('space.bilibili.com')) {
      const match = link.href.match(/space\.bilibili\.com\/(\d+)/);
      if (match) uid = match[1];
    }

    // 1b. B 站数据属性 biliscope-userid（动态流用户名 span、头像等无 href 场景）
    if (!uid && link.getAttribute && link.getAttribute('biliscope-userid')) {
      uid = link.getAttribute('biliscope-userid');
    }

    // 1c. 从所在动态卡片的头像数据属性取 uid（bilisponsor-userid / biliscope-userid），
    //     覆盖纯文字/专栏/直播预告等无视频链接的动态
    if (!uid) {
      const card = link.closest('.bili-dyn-item, .bili-dyn-list__item');
      if (card) {
        const sponsor = card.querySelector('[bilisponsor-userid]');
        if (sponsor) uid = sponsor.getAttribute('bilisponsor-userid');
        if (!uid) {
          const scope = card.querySelector('[biliscope-userid]');
          if (scope) uid = scope.getAttribute('biliscope-userid');
        }
      }
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

    // 3. 直播区链接 (live.bilibili.com/房间号)，通过 API 解析主播 uid
    if (!uid && !bvid && link.href && link.href.includes('live.bilibili.com')) {
      const match = link.href.match(/live\.bilibili\.com\/(\d+)/);
      if (match) roomId = match[1];
    }

    // 4. 直播区条目（t.bilibili.com 侧栏）：主播名是 div 而非链接，需异步按名字解析 uid
    if (!uid && !bvid && !roomId && link.matches && link.matches('.bili-dyn-live-users__item__uname')) {
      const name = link.textContent.trim();
      if (!name) return;
      resolveLiveUid(name).then(mid => {
        if (!mid || !link.isConnected) return;
        const button = createBlockButton(mid);
        link.insertAdjacentElement('afterend', button);
        fixButtonOverflowParent(link);
        setupHoverTrigger(link, 'user', mid);
      });
      return; // 直播条目不走下方同步渲染分支
    }

    // 排除当前登录用户本人的链接（从顶栏用户入口读取 mid 作兜底）
    const myMid = getMyMid();
    if (myMid && uid === myMid) return;

    // 5. 根据获取到的信息渲染按钮
    if (uid || bvid || roomId) {
      // 如果有 UID 直接创建，如果没有 UID 但有 BVID，则创建“延迟加载”按钮
      const button = createBlockButton(uid, bvid, roomId);

      // 将按钮插入到链接元素的旁边
      link.insertAdjacentElement('afterend', button);

      // 样式修复：针对热门/排行榜等页面，父容器可能有 overflow: hidden 导致按钮不可见
      fixButtonOverflowParent(link);

      // 添加悬停显示用户信息功能（直播区无 space 链接，不挂悬停）
      if (uid) {
        setupHoverTrigger(link, 'user', uid);
      } else if (bvid) {
        setupHoverTrigger(link, 'user-resolve', bvid);
      }
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
