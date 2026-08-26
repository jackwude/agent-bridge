// Agent Bridge - Content Script
// 不使用 eval，通过 script 元素注入执行
// 用 CustomEvent 一次性通知替代 50ms 轮询

const AB_EVENT = '__abDone_' + Math.random().toString(36).slice(2, 8);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'agentBridgeExecute') {
    const timer = setTimeout(() => {
      sendResponse({ success: false, error: 'Execute timeout (30s)' });
    }, 30000);

    const onDone = (e) => {
      clearTimeout(timer);
      const d = e.detail;
      if (d && d.ok) {
        sendResponse({ success: true, result: String(d.v) });
      } else {
        sendResponse({ success: false, error: d ? d.v : 'Unknown error' });
      }
    };

    window.addEventListener(AB_EVENT, onDone, { once: true });

    const script = document.createElement('script');
    script.textContent = `
      (async()=>{
        try {
          const r = await (${message.code});
          window.dispatchEvent(new CustomEvent("${AB_EVENT}", { detail: { ok: true, v: r } }));
        } catch(e) {
          window.dispatchEvent(new CustomEvent("${AB_EVENT}", { detail: { ok: false, v: e.message || String(e) } }));
        }
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    return true;  // 异步响应
  }
});

console.log('[Agent Bridge] Content script 已加载');
