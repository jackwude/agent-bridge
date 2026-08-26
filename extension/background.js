// Agent Bridge - Background Service Worker

const WS_PORT = 18910;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const AB_EVENT = '__abBg_' + Math.random().toString(36).slice(2, 8);  // 唯一事件名
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;  // 指数退避初始值（2s，更快重连）
let keepAliveTimer = null;

// 保活：每 15 秒发一次 ping（Chrome MV3 SW 30s 超时，15s 更安全）
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log('[Agent Bridge] ✅ 已连接');
    reconnectDelay = 2000;  // 连接成功后重置退避
    sendTabsInfo();
    startKeepAlive();  // 启动 15s 保活 ping
  };
  ws.onclose = () => { ws = null; stopKeepAlive(); scheduleReconnect(); };
  ws.onerror = () => {};
  ws.onmessage = async (event) => {
    try { await handleCommand(JSON.parse(event.data)); } catch (e) { console.error(e); }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[Agent Bridge] ${reconnectDelay/1000}s 后重连...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);  // 指数退避，最大 60s
    connect();
  }, reconnectDelay);
}

async function handleCommand(command) {
  const { action, id, params } = command;
  console.log('[Agent Bridge] 命令:', action);
  try {
    switch (action) {
      case 'execute':
        const result = await executeScript(params.code, params.tabId);
        sendResponse({ id, result }); break;
      case 'getTabs':
        sendResponse({ id, tabs: await getTabsInfo() }); break;
      case 'navigate':
        await navigate(params.url, params.tabId);
        sendResponse({ id, success: true }); break;
      case 'closeTab':
        await chrome.tabs.remove(params.tabId);
        sendResponse({ id, success: true }); break;
      case 'screenshot':
        sendResponse({ id, dataUrl: await takeScreenshot(params.tabId, params.format) }); break;
      case 'reloadSelf':
        chrome.runtime.reload();  // 重新加载扩展，service worker 重启
        break;
      case 'click':
        const clickResult = await clickElement(params.selector, params.tabId);
        sendResponse({ id, result: clickResult }); break;
      case 'type':
        const typeResult = await typeText(params.selector, params.text, params.tabId, params.delay);
        sendResponse({ id, result: typeResult }); break;
      case 'fill':
        const fillResult = await fillValue(params.selector, params.value, params.tabId);
        sendResponse({ id, result: fillResult }); break;
      case 'waitFor':
        const waitResult = await waitForElement(params.selector, params.tabId, params.timeout);
        sendResponse({ id, result: waitResult }); break;
      case 'getCookies':
        const cookies = await chrome.cookies.getAll(params.domain ? {domain: params.domain} : {});
        sendResponse({ id, cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, session: c.session})) });
        break;
      default:
        sendResponse({ id, error: `Unknown: ${action}` });
    }
  } catch (error) {
    sendResponse({ id, error: error.message });
  }
}

// 注入脚本元素来执行代码（绕过 CSP）
// 支持 async/await：用 CustomEvent 一次性通知替代轮询
async function executeScript(code, tabId) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error('No active tab');
    targetTabId = tabs[0].id;
  }

  await chrome.tabs.update(targetTabId, { active: true });

  // 第一次注入：执行代码，用 CustomEvent 返回结果
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (userCode, eventName) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 30000);  // 30s 超时

        window.addEventListener(eventName, function handler(e) {
          window.removeEventListener(eventName, handler);
          clearTimeout(timer);
          resolve(e.detail);
        }, { once: true });

        const script = document.createElement('script');
        script.textContent = `
          (async()=>{
            try {
              const r = await (${userCode});
              window.dispatchEvent(new CustomEvent("${eventName}", { detail: { ok: true, v: r } }));
            } catch(e) {
              window.dispatchEvent(new CustomEvent("${eventName}", { detail: { ok: false, v: e.message || String(e) } }));
            }
          })();
        `;
        document.head.appendChild(script);
        script.remove();
      });
    },
    args: [code, AB_EVENT],
    world: 'MAIN',
    injectImmediately: true
  });

  if (results && results[0] && results[0].result) {
    const r = results[0].result;
    if (r.ok) return String(r.v);
    throw new Error(r.v);
  }
  return null;
}

async function getTabsInfo() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

async function navigate(url, tabId) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error('No active tab');
    targetTabId = tabs[0].id;
  }
  await chrome.tabs.update(targetTabId, { url });
}

async function takeScreenshot(tabId, format) {
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error('No active tab');
    targetTabId = tabs[0].id;
  }
  await chrome.tabs.update(targetTabId, { active: true });
  await new Promise(r => setTimeout(r, 200));  // 减少等待：500ms → 200ms
  const fmt = format === 'jpg' ? 'jpeg' : (format || 'png');
  return await chrome.tabs.captureVisibleTab(null, { format: fmt });
}

// ==================== P0: 交互命令实现 ====================

// 通用：获取目标 tabId（优先传入值，否则用当前活跃 tab）
async function resolveTabId(tabId) {
  if (tabId) return tabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('No active tab');
  return tabs[0].id;
}

// 点击元素：滚动到可见 + 模拟完整鼠标事件
async function clickElement(selector, tabId) {
  const targetTabId = await resolveTabId(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, v: 'Element not found: ' + sel };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      // 等待滚动完成
      return new Promise((resolve) => {
        setTimeout(() => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          // 完整鼠标事件序列
          for (const type of ['mouseenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, view: window,
              clientX: x, clientY: y, button: 0
            }));
          }
          resolve(`Clicked ${sel} at (${Math.round(x)}, ${Math.round(y)})`);
        }, 50);  // 减少等待：100ms → 50ms
      });
    },
    args: [selector],
    world: 'MAIN',
    injectImmediately: true
  });
  const r = results?.[0]?.result;
  if (r && r.ok === false) throw new Error(r.v);
  return r || 'Clicked';
}

// 输入文字：聚焦 + 逐字触发 input 事件
async function typeText(selector, text, tabId, delay) {
  const targetTabId = await resolveTabId(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (sel, txt, dly) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, v: 'Element not found: ' + sel };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.focus();
      // 清空已有内容
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // 逐字输入
      return new Promise((resolve) => {
        let i = 0;
        const timer = setInterval(() => {
          if (i >= txt.length) {
            clearInterval(timer);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            resolve(`Typed ${txt.length} chars into ${sel}`);
            return;
          }
          el.value += txt[i];
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: txt[i], bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: txt[i], bubbles: true }));
          i++;
        }, dly || 0);
      });
    },
    args: [selector, text, delay || 0],
    world: 'MAIN',
    injectImmediately: true
  });
  const r = results?.[0]?.result;
  if (r && r.ok === false) throw new Error(r.v);
  return r || 'Typed';
}

// 直接填充值：绕过 React 受控组件（用 nativeInputValueSetter）
async function fillValue(selector, value, tabId) {
  const targetTabId = await resolveTabId(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, v: 'Element not found: ' + sel };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.focus();
      // 用 nativeInputValueSetter 绕过 React 受控组件
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, val);
      } else {
        el.value = val;
      }
      // 触发完整事件链
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Filled "${val}" into ${sel}`;
    },
    args: [selector, value],
    world: 'MAIN',
    injectImmediately: true
  });
  const r = results?.[0]?.result;
  if (r && r.ok === false) throw new Error(r.v);
  return r || 'Filled';
}

// 等待元素出现：MutationObserver + 轮询兜底
async function waitForElement(selector, tabId, timeout) {
  const targetTabId = await resolveTabId(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (sel, tout) => {
      return new Promise((resolve) => {
        const timeoutMs = tout || 10000;
        // 先检查元素是否已存在
        const existing = document.querySelector(sel);
        if (existing) {
          resolve(`Element found immediately: ${sel}`);
          return;
        }
        let resolved = false;
        const done = (msg) => {
          if (resolved) return;
          resolved = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(msg);
        };
        // MutationObserver 监听 DOM 变化
        const observer = new MutationObserver((mutations) => {
          if (document.querySelector(sel)) {
            done(`Element appeared: ${sel}`);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // 轮询兜底（每 200ms 检查一次）
        const poll = setInterval(() => {
          if (document.querySelector(sel)) {
            clearInterval(poll);
            done(`Element found by poll: ${sel}`);
          }
        }, 200);
        // 超时
        const timer = setTimeout(() => {
          clearInterval(poll);
          done(`Timeout (${timeoutMs}ms): ${sel} not found`);
        }, timeoutMs);
      });
    },
    args: [selector, timeout || 10000],
    world: 'MAIN',
    injectImmediately: true
  });
  return results?.[0]?.result || 'Waited';
}


function sendResponse(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function sendTabsInfo() {
  getTabsInfo().then(tabs => sendResponse({ type: 'tabsInfo', tabs }));
}

// --- Tab 变化时同步 ---
chrome.tabs.onCreated.addListener(sendTabsInfo);
chrome.tabs.onRemoved.addListener(sendTabsInfo);
chrome.tabs.onUpdated.addListener(sendTabsInfo);
chrome.tabs.onActivated.addListener(sendTabsInfo);

// --- 连接 ---
connect();

// --- 保活机制 ---
// Chrome MV3 alarm 最小间隔 1 分钟，会唤醒 SW
// 双 alarm 保险：一个检查连接，一个发心跳防断
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    // 心跳：即使已连接也发一次 tabsInfo，保持 SW 活跃
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendTabsInfo();
    }
  }
  if (alarm.name === 'keepAlive') {
    // 连接检查：断了就重连
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[Agent Bridge] 🔌 检测到断连，重连中...');
      connect();
    }
  }
});

// SW 启动时立即连接
console.log('[Agent Bridge] ✅ Service Worker 已启动');