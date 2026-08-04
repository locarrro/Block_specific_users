// ============================================================
// Bilibili 黑名单增强助手 - UI 组件（拉黑按钮 / 悬停 tooltip / toast）
// 依赖 api.js 提供的直连 API 与缓存实例（须在 api.js 之后加载）。
// ============================================================

let hideTooltipTimer = null; // For managing tooltip hide delay

// 执行拉黑/解除并统一错误提示（两套拉黑按钮共用的写操作入口）
async function modifyAndNotify(uid, action) {
  const response = await modifyRelation(uid, action);
  if (!response.success) showToast(response.message);
  return response;
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
    modifyAndNotify(uid, 5).then(response => {
      if (response.success) {
        // 拉黑成功后，隐藏卡片
        card.style.display = 'none';
      } else {
        btn.innerText = '拉黑UP';
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

    button.innerText = '...';
    button.disabled = true;

    modifyAndNotify(uid, action).then(response => {
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
