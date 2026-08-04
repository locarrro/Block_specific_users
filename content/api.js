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
    apiGetWithWbi(`https://api.bilibili.com/x/space/arc/search?mid=${uid}&ps=50&pn=1`)
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

// 获取关注列表（翻页拉取，用于直播区按主播名解析 uid）
async function fetchFollowings(mid) {
  const list = [];
  const pageSize = 50;
  // 最多拉 8 页（400 人），足够覆盖绝大多数关注量
  for (let pn = 1; pn <= 8; pn++) {
    const data = await apiGet(`https://api.bilibili.com/x/relation/followings?vmid=${mid}&pn=${pn}&ps=${pageSize}&order=attention`);
    if (data.code !== 0 || !data.data || !data.data.list) break;
    list.push(...data.data.list.map(u => ({ mid: String(u.mid), uname: u.uname })));
    if (!data.data.has_more || (data.data.total && list.length >= data.data.total)) break;
  }
  if (list.length === 0) return { success: false, error: '关注列表为空或获取失败' };
  return { success: true, list };
}

// 通过房间号获取主播 uid（直播区拉黑按钮用）
async function fetchRoomOwner(roomId) {
  const data = await apiGet(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`);
  if (data.code === 0 && data.data && data.data.uid) {
    return { success: true, uid: String(data.data.uid) };
  }
  return { success: false, error: data.message || '无法获取主播信息' };
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

// --- wbi 签名（B 站公开算法） ---
// 用于 arc/search 等要求 wbi 签名的接口；签名失败时调用方回退为原始请求。

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

// 纯 JS MD5（WebCrypto 不支持 MD5，内嵌公共领域实现）
function md5(string) {
  function RotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }
  function AddUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }
  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }
  function FF(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function GG(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function HH(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function II(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function ConvertToWordArray(string) {
    let lWordCount;
    const lMessageLength = string.length;
    const lNumberOfWordsTempOne = lMessageLength + 8;
    const lNumberOfWordsTempTwo = (lNumberOfWordsTempOne - (lNumberOfWordsTempOne % 64)) / 64;
    const lNumberOfWords = (lNumberOfWordsTempTwo + 1) * 16;
    const lWordArray = Array(lNumberOfWords - 1);
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < lMessageLength) {
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition));
      lByteCount++;
    }
    lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  }
  function WordToHex(lValue) {
    let WordToHexValue = '';
    let WordToHexValueTemp = '';
    let lByte;
    let lCount;
    for (lCount = 0; lCount <= 3; lCount++) {
      lByte = (lValue >>> (lCount * 8)) & 255;
      WordToHexValueTemp = `0${lByte.toString(16)}`;
      WordToHexValue = WordToHexValue + WordToHexValueTemp.substr(WordToHexValueTemp.length - 2, 2);
    }
    return WordToHexValue;
  }
  let x = [];
  let k;
  let AA;
  let BB;
  let CC;
  let DD;
  let a;
  let b;
  let c;
  let d;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
  string = unescape(encodeURIComponent(string)); // 转 UTF-8 字节序列
  x = ConvertToWordArray(string);
  a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;
  for (k = 0; k < x.length; k += 16) {
    AA = a; BB = b; CC = c; DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB);
    b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A);
    c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D);
    d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
    a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA);
    c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x4881D05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039);
    d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
    b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xF4292244);
    d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97);
    c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
    b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
    d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92);
    c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
    b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F);
    d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k + 6], S43, 0xA3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82);
    d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
    c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB);
    b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391);
    a = AddUnsigned(a, AA);
    b = AddUnsigned(b, BB);
    c = AddUnsigned(c, CC);
    d = AddUnsigned(d, DD);
  }
  return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

// nav 接口的 img/sub key 缓存（24 小时）
let wbiKeysCache = null;

async function getWbiKeys() {
  if (wbiKeysCache && Date.now() - wbiKeysCache.ts < 24 * 60 * 60 * 1000) return wbiKeysCache;
  const data = await apiGet('https://api.bilibili.com/x/web-interface/nav');
  if (data.code !== 0 || !data.data || !data.data.wbi_img) return null;
  const { img_url, sub_url } = data.data.wbi_img;
  const imgKey = img_url.slice(img_url.lastIndexOf('/') + 1).split('.')[0];
  const subKey = sub_url.slice(sub_url.lastIndexOf('/') + 1).split('.')[0];
  if (!imgKey || !subKey) return null;
  wbiKeysCache = { imgKey, subKey, ts: Date.now() };
  return wbiKeysCache;
}

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return mixinKeyEncTab.map(i => raw[i]).join('').slice(0, 32);
}

// 对参数对象做 wbi 签名，返回 query 字符串（含 wts/w_rid）；失败返回 null
async function wbiSign(params) {
  const keys = await getWbiKeys();
  if (!keys) return null;
  const mixinKey = getMixinKey(keys.imgKey, keys.subKey);
  const query = { ...params, wts: Math.round(Date.now() / 1000) };
  const queryStr = Object.keys(query)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');
  const w_rid = md5(queryStr + mixinKey);
  return `${queryStr}&w_rid=${w_rid}`;
}

// 对 URL 的 query 参数做 wbi 签名；签名失败返回 null（调用方回退原始请求）
async function wbiSignUrl(url) {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return null;
  const params = {};
  for (const pair of url.slice(queryIndex + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  const signed = await wbiSign(params);
  return signed ? `${url.slice(0, queryIndex)}?${signed}` : null;
}

// 带 wbi 签名的 GET：签名失败时回退为原始请求
async function apiGetWithWbi(url) {
  const signed = await wbiSignUrl(url);
  return apiGet(signed || url);
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
const fetchRoomOwnerCached = cached(fetchRoomOwner, 10 * 60 * 1000);
const fetchFollowingsCached = cached(fetchFollowings, 10 * 60 * 1000);
