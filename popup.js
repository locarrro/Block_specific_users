document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('fetchBlacklistBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const searchInput = document.getElementById('searchInput');
  const statusDiv = document.getElementById('status');
  const userListDiv = document.getElementById('userList');
  const keywordInput = document.getElementById('keywordInput');
  const saveKeywordBtn = document.getElementById('saveKeywordBtn');

  // 全量黑名单 [{mid, uname}]，本地内存态
  let blacklist = [];
  let filterText = '';

  // 加载已保存的关键词
  chrome.storage.local.get(['targetKeyword'], (result) => {
    if (result.targetKeyword) keywordInput.value = result.targetKeyword;
  });

  // 保存关键词
  saveKeywordBtn.addEventListener('click', () => {
    const keyword = keywordInput.value.trim();
    chrome.storage.local.set({ targetKeyword: keyword }, () => {
      showStatus('关键词已保存，刷新 B 站页面生效。');
    });
  });

  // 读取完整黑名单（background 翻页拉全量）
  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    showStatus('正在获取黑名单...');
    const response = await sendMessage({ type: 'getBlacklist' });
    fetchBtn.disabled = false;
    if (!response || !response.success) {
      showStatus('获取失败：' + ((response && response.error) || '未知错误'));
      return;
    }
    const apiData = response.data;
    if (apiData.code === -101) {
      showStatus('尚未登录。请先登录 bilibili.com 再重试。');
      return;
    }
    if (apiData.code !== 0) {
      showStatus('API 错误：' + (apiData.message || apiData.code));
      return;
    }
    blacklist = ((apiData.data && apiData.data.list) || []).map(u => ({
      mid: String(u.mid),
      uname: u.uname || '',
    }));
    exportBtn.disabled = importBtn.disabled = false;
    render();
  });

  // 本地过滤搜索
  searchInput.addEventListener('input', () => {
    filterText = searchInput.value.trim().toLowerCase();
    render();
  });

  // 导出 JSON 备份
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(blacklist, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bilibili-blacklist-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus(`已导出 ${blacklist.length} 条黑名单记录。`);
  });

  // 导入 JSON 备份（批量拉黑）
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : (data.list || []);
      const fids = [];
      for (const item of arr) {
        const mid = item && (item.mid !== undefined ? item.mid : item.fid);
        if (mid !== undefined && mid !== null && /^\d+$/.test(String(mid))) {
          fids.push(String(mid));
        }
      }
      if (!fids.length) {
        showStatus('导入文件中没有有效的 UID（需要 mid/fid 字段，数字）。');
        return;
      }
      showStatus(`正在批量拉黑 ${fids.length} 人...`);
      const result = await sendMessage({ type: 'blockUsers', fids });
      const failed = (result && result.errors) || [];
      let msg = `导入完成：成功 ${result ? result.ok : 0}，失败 ${result ? result.fail : '?'}`;
      if (failed.length) {
        msg += '（' + failed.slice(0, 3).map(e => e.fid).join(', ') + '...）';
      }
      showStatus(msg);
    } catch (e) {
      showStatus('导入失败：' + e.message);
    }
  });

  // 渲染列表（按过滤词）
  function render() {
    const keyword = filterText;
    const filtered = blacklist.filter(u =>
      !keyword ||
      u.uname.toLowerCase().includes(keyword) ||
      u.mid.includes(keyword)
    );
    userListDiv.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;text-align:center;color:#999;font-size:12px;';
      empty.textContent = blacklist.length ? '无匹配结果' : '黑名单为空';
      userListDiv.appendChild(empty);
      showStatus(`共 ${blacklist.length} 人` + (keyword ? `，匹配 ${filtered.length} 人` : ''));
      return;
    }
    filtered.forEach(u => {
      const item = document.createElement('div');
      item.className = 'user-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'uname';
      nameSpan.textContent = u.uname || '(未命名)';

      const uidSpan = document.createElement('span');
      uidSpan.className = 'uid';
      uidSpan.textContent = u.mid;

      const link = document.createElement('a');
      link.href = `https://space.bilibili.com/${u.mid}`;
      link.target = '_blank';
      link.textContent = '主页';

      const btn = document.createElement('button');
      btn.textContent = '解除';
      btn.addEventListener('click', () => unblock(u, btn));

      item.append(nameSpan, uidSpan, link, btn);
      userListDiv.appendChild(item);
    });
    showStatus(`共 ${blacklist.length} 人` + (keyword ? `，匹配 ${filtered.length} 人` : ''));
  }

  // 解除拉黑单个用户
  async function unblock(u, btn) {
    if (!window.confirm(`确定解除拉黑「${u.uname || u.mid}」？`)) return;
    btn.disabled = true;
    btn.textContent = '处理中...';
    const res = await sendMessage({ type: 'unblockUser', fid: u.mid });
    if (res && res.success) {
      blacklist = blacklist.filter(x => x.mid !== u.mid);
      render();
      showStatus(`已解除「${u.uname || u.mid}」的拉黑。`);
    } else {
      btn.disabled = false;
      btn.textContent = '解除';
      showStatus('解除失败：' + ((res && res.error) || '未知错误'));
    }
  }

  function showStatus(text) {
    statusDiv.textContent = text;
  }

  function sendMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }
});
