// d:\project\user.js\Block_specific_users\content.js

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

// 使用 MutationObserver 监视整个文档的动态变化（例如，评论的加载）
const observer = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    if (mutation.addedNodes.length) {
      // 修复：遍历所有新添加的节点，而不是它们的父节点
      mutation.addedNodes.forEach(node => {
        // 我们只关心元素节点
        if (node.nodeType === Node.ELEMENT_NODE) {
          findAndProcessUsernames(node);
          findAndProcessVideoCards(node);
        }
      });
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
        try {
          chrome.runtime.sendMessage({ type: 'getVideoInfo', bvid }, (res) => {
            if (chrome.runtime.lastError) return; // 防止异步回调报错
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
        } catch (e) {
          // 插件上下文已失效，忽略错误
        }
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
    chrome.runtime.sendMessage({ type: 'modifyRelation', uid, action: 5 }, response => {
      if (response.success) {
        // 拉黑成功后，隐藏卡片
        card.style.display = 'none';
      } else {
        btn.innerText = '拉黑UP';
        alert(response.message);
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
      try {
        chrome.runtime.sendMessage({ type: 'getVideoInfo', bvid }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.success && res.data.mid) {
            uid = res.data.mid;
            button.dataset.uid = uid;
            checkStatus(); // 获取到 UID 后再检查状态
          } else {
            button.innerText = '?';
            button.title = '无法获取用户信息';
          }
        });
      } catch (e) {
        // 插件上下文已失效
      }
    } else if (uid) {
      checkStatus();
    }
  };

  // 按需检查状态
  const checkStatus = () => {
    try {
      chrome.runtime.sendMessage({ type: 'checkBlockStatus', uid }, response => {
      if (chrome.runtime.lastError) return;
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
    } catch (e) {
      // 插件上下文已失效
    }
  };

  // 启动初始化
  init();

  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!uid) return; // 防御性编程

    const isBlocked = button.dataset.blocked === 'true';
    const action = isBlocked ? 6 : 5; // 5:拉黑, 6:解除
    const actionText = isBlocked ? '解除拉黑' : '拉黑';

    button.innerText = '...';
    button.disabled = true;

    chrome.runtime.sendMessage({ type: 'modifyRelation', uid, action }, response => {
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
        alert(response.message);
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

function showTooltip(targetElement, type, id) {
  // 移除旧的
  const old = document.getElementById('ext-hover-tooltip');
  if (old) old.remove();

  const tooltip = document.createElement('div');
  tooltip.id = 'ext-hover-tooltip';
  tooltip.innerHTML = '<div class="ext-loading">加载中...</div>';
  
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
        const originalContent = tooltip.innerHTML;
        tooltip.innerHTML = `<div class="ext-copied-message">UID 已复制!</div>`;
        
        setTimeout(() => {
          if (document.getElementById('ext-hover-tooltip')) {
            tooltip.innerHTML = originalContent;
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

    try {
      chrome.runtime.sendMessage({ type: 'getUserInfo', uid: id }, (res) => {
        if (chrome.runtime.lastError) {
          tooltip.innerHTML = '连接断开，请刷新页面';
          return;
        }
        if (!document.getElementById('ext-hover-tooltip')) return;
        if (res.success) {
          const d = res.data;
          const wc = d.wordCloud.map(w => `${w.word}`).join(' ');
          tooltip.innerHTML = `
            <div class="ext-tt-title">用户详情 (UID: ${d.uid})</div>
            <div>视频数: ${d.videoCount} | 粉丝: ${d.follower}</div>
            <div>平均时长: ${d.avgLength}</div>
            <div class="ext-tt-cloud">词云: ${wc || '无'}</div>
          `;
        } else {
          tooltip.innerHTML = `加载失败: ${res.error}`;
        }
      });
    } catch (e) {
      tooltip.innerHTML = '插件已更新，请刷新页面';
    }
  } else if (type === 'user-resolve') {
    // 新增：先通过 BVID 获取 UID，再显示用户信息
    tooltip.innerHTML = '<div class="ext-loading">正在解析用户信息...</div>';
    try {
      chrome.runtime.sendMessage({ type: 'getVideoInfo', bvid: id }, (res) => {
        if (res.success && res.data.mid) {
          // 获取成功，转为普通的 user 类型显示
          showTooltip(targetElement, 'user', res.data.mid);
        } else {
          tooltip.innerHTML = '无法获取用户信息';
        }
      });
    } catch (e) {
      tooltip.innerHTML = '插件已更新，请刷新页面';
    }
  } else if (type === 'video') {
    try {
      chrome.runtime.sendMessage({ type: 'getVideoInfo', bvid: id }, (res) => {
        if (chrome.runtime.lastError) {
          tooltip.innerHTML = '连接断开，请刷新页面';
          return;
        }
        if (!document.getElementById('ext-hover-tooltip')) return;
        if (res.success) {
          const d = res.data;
          tooltip.innerHTML = `
            <div class="ext-tt-title">视频详情</div>
            <div class="ext-tt-tags">Tags: ${d.tags.slice(0, 8).join(', ')}...</div>
            <div class="ext-tt-ai"><strong>AI总结:</strong> ${d.aiSummary || '暂无'}</div>
          `;
        } else {
          tooltip.innerHTML = `加载失败: ${res.error}`;
        }
      });
    } catch (e) {
      tooltip.innerHTML = '插件已更新，请刷新页面';
    }
  }
}
