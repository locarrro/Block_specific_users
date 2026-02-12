document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('fetchBlacklistBtn');
  const outputDiv = document.getElementById('output');
  const keywordInput = document.getElementById('keywordInput');
  const saveKeywordBtn = document.getElementById('saveKeywordBtn');

  // 加载已保存的关键词
  chrome.storage.local.get(['targetKeyword'], (result) => {
    if (result.targetKeyword) {
      keywordInput.value = result.targetKeyword;
    }
  });

  // 保存关键词
  saveKeywordBtn.addEventListener('click', () => {
    const keyword = keywordInput.value.trim();
    chrome.storage.local.set({ targetKeyword: keyword }, () => {
      alert('关键词已保存，请刷新 B 站页面生效。');
    });
  });
  
  fetchBtn.addEventListener('click', async () => {
    outputDiv.textContent = '正在获取数据...';
    
    // 向 background.js 发送消息请求黑名单数据
    chrome.runtime.sendMessage({ type: 'getBlacklist' }, (response) => {
      if (response && response.success) {
        const apiData = response.data;
        if (apiData.code === 0) {
          if (apiData.data && apiData.data.list && apiData.data.list.length > 0) {
            const userList = apiData.data.list.map(user => ` - ${user.uname} (UID: ${user.mid})`).join('\n');
            outputDiv.textContent = `成功获取 ${apiData.data.list.length} 位用户:\n${userList}`;
          } else {
            outputDiv.textContent = '你的黑名单是空的。';
          }
        } else if (apiData.code === -101) {
          outputDiv.textContent = '错误：尚未登录。请先登录bilibili.com。';
        } else {
          outputDiv.textContent = `API 返回错误: ${apiData.message} (code: ${apiData.code})`;
        }
      } else {
        console.error('获取黑名单失败:', response.error);
        outputDiv.textContent = `获取失败，请检查网络连接或查看控制台错误。\n错误信息: ${response.error}`;
      }
    });
  });
});
