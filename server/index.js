#!/usr/bin/env node
// Agent Bridge - Local HTTP Server (v2: auth + health + log rotation)
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HTTP_PORT = 18900;
const WS_PORT = 18910;
const AUTH_TOKEN = process.env.AB_TOKEN || generateToken();
const LOG_FILE = path.join(process.env.HOME, '.hermes/logs/agent-bridge.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let connectedExt = null;
let commandId = 0;
let lastTabs = [];
const pendingCommands = new Map();
const MAX_PENDING = 200;
const startTime = Date.now();
let requestCount = 0;
let errorCount = 0;

// ==================== 按需恢复看门狗（2026-08-25 替代巡逻式窗口守护） ====================
// 仅当业务请求到达且扩展断连时才拉起自动化 Chrome；带熔断与飞书告警，详见 watchdog.js 头注释
const wd = require('./watchdog').createWatchdog({
  isConnected: () => !!connectedExt && connectedExt.readyState === WebSocket.OPEN,
});

// ==================== Token 生成 ====================
function generateToken() {
  const tokenPath = path.join(process.env.HOME, '.hermes/agent-bridge-token');
  try {
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf8').trim();
    }
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {}
  console.log(`[Agent Bridge] 🔑 Token: ${token.slice(0, 8)}...${token.slice(-4)}`);
  return token;
}

// ==================== 日志（带轮转） ====================
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  console.log(line.trim());
  try {
    // 轮转检查
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const oldLog = LOG_FILE + '.old';
        if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
        fs.renameSync(LOG_FILE, oldLog);
      }
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// ==================== 认证中间件 ====================
function checkAuth(req, res) {
  // health 端点不需要认证
  if (new URL(req.url, `http://localhost`).pathname === '/health') return true;

  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'Add header: Authorization: Bearer <token>' }));
    return false;
  }
  return true;
}

// ==================== HTTP 服务 ====================
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 认证检查
  if (!checkAuth(req, res)) {
    errorCount++;
    return;
  }

  requestCount++;
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  const pathname = url.pathname;

  // 健康检查（不需要走 WebSocket，不需要认证）
  if (pathname === '/health') {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const avgMs = successCount > 0 ? Math.round(totalResponseMs / successCount) : 0;
    const lastSuccessAgo = lastSuccessTime ? Math.floor((Date.now() - lastSuccessTime) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connected: !!connectedExt,
      uptime_s: uptime,
      requests: requestCount,
      errors: errorCount,
      pending: pendingCommands.size,
      success: successCount,
      avg_ms: avgMs,
      last_success_s: lastSuccessAgo,
      watchdog: wd.status(),
    }));
    return;
  }

  // 获取标签页
  if (pathname === '/tabs') {
    if (lastTabs.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lastTabs));
    } else {
      handleRequest('getTabs', {}, res);
    }
    return;
  }

  // 执行 JS
  if (pathname === '/execute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { code, tabId } = JSON.parse(body);
        handleRequest('execute', { code, tabId }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }


  // 获取 cookies
  if (pathname === '/cookies' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { domain } = JSON.parse(body);
        handleRequest('getCookies', { domain: domain || '' }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 导航
  if (pathname === '/navigate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { url, tabId } = JSON.parse(body);
        handleRequest('navigate', { url, tabId }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 关闭标签页
  if (pathname === '/close' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { tabId } = JSON.parse(body);
        if (!tabId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'tabId is required' }));
          return;
        }
        handleRequest('closeTab', { tabId }, res);
        // 后台等待重连（关 tab 可能导致 service worker 重启）
        const start = Date.now();
        const wait = setInterval(() => {
          if (connectedExt && connectedExt.readyState === WebSocket.OPEN) {
            clearInterval(wait);
            log(`✓ closeTab 后重连 (${Date.now() - start}ms)`);
          } else if (Date.now() - start > 10000) {
            clearInterval(wait);
          }
        }, 500);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 截图
  if (pathname === '/screenshot' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { tabId, format } = body ? JSON.parse(body) : {};
        handleRequest('screenshot', { tabId, format }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 重新加载扩展
  if (pathname === '/reload' && req.method === 'POST') {
    if (!connectedExt || connectedExt.readyState !== WebSocket.OPEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Chrome extension connected' }));
      return;
    }
    const id = ++commandId;
    connectedExt.send(JSON.stringify({ action: 'reloadSelf', id }));
    // reload 后等待扩展重连（最多 15 秒）
    const reloadStart = Date.now();
    const waitForReconnect = setInterval(() => {
      if (connectedExt && connectedExt.readyState === WebSocket.OPEN) {
        clearInterval(waitForReconnect);
        log(`✓ reload #${id} 扩展已重连 (${Date.now() - reloadStart}ms)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, reconnected: true, elapsed_ms: Date.now() - reloadStart }));
      } else if (Date.now() - reloadStart > 15000) {
        clearInterval(waitForReconnect);
        log(`⏱ reload #${id} 重连超时 15s`);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Extension reconnect timeout (15s)' }));
      }
    }, 500);
    return;
  }


  // ==================== P0: 交互命令 ====================

  // 点击元素
  if (pathname === '/click' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { selector, tabId } = JSON.parse(body);
        if (!selector) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'selector is required' }));
          return;
        }
        handleRequest('click', { selector, tabId }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 输入文字（模拟键盘逐字输入）
  if (pathname === '/type' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { selector, text, tabId, delay } = JSON.parse(body);
        if (!selector || text === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'selector and text are required' }));
          return;
        }
        handleRequest('type', { selector, text, tabId, delay }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 直接填充值（绕过 React 受控组件）
  if (pathname === '/fill' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { selector, value, tabId } = JSON.parse(body);
        if (!selector || value === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'selector and value are required' }));
          return;
        }
        handleRequest('fill', { selector, value, tabId }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 等待元素出现
  if (pathname === '/waitFor' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { selector, tabId, timeout } = JSON.parse(body);
        if (!selector) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'selector is required' }));
          return;
        }
        handleRequest('waitFor', { selector, tabId, timeout }, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ==================== 连接等待（请求排队） ====================
const WAIT_RECONNECT_MS = 5000;  // 断连时最多等 5s 看是否重连

function waitForReconnect(timeoutMs) {
  return new Promise((resolve) => {
    if (connectedExt && connectedExt.readyState === WebSocket.OPEN) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const check = setInterval(() => {
      if (connectedExt && connectedExt.readyState === WebSocket.OPEN) {
        clearInterval(check);
        log(`✓ 等待重连成功 (${Date.now() - start}ms)`);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, 200);
  });
}

// ==================== 命令处理 ====================
const TIMEOUTS = {
  getTabs: 10000,
  execute: 30000,
  navigate: 60000,
  screenshot: 15000,
  closeTab: 10000,
  click: 10000,
  type: 30000,
  fill: 10000,
  waitFor: 30000,
};

// 成功/失败统计
let successCount = 0;
let totalResponseMs = 0;
let lastSuccessTime = null;

async function handleRequest(action, params, res) {
  const startTime = Date.now();

  // 扩展断连时，先等 5s 看是否自然重连；仍断则按需恢复（精准拉起自动化实例，含熔断）
  if (!connectedExt || connectedExt.readyState !== WebSocket.OPEN) {
    log(`⏳ 扩展断连，等待重连 (${action})...`);
    let reconnected = await waitForReconnect(WAIT_RECONNECT_MS);
    if (!reconnected) reconnected = await wd.ensureBridgeAvailable(action);
    if (!reconnected) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Chrome extension connected (auto-recovery failed or circuit open)' }));
      return;
    }
  }

  if (pendingCommands.size >= MAX_PENDING) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many pending commands' }));
    return;
  }

  const id = ++commandId;
  const timeout = TIMEOUTS[action] || 30000;
  const message = JSON.stringify({ action, id, params });

  const timer = setTimeout(() => {
    pendingCommands.delete(id);
    log(`⏱ ${action} timeout ${timeout}ms #${id}`);
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Command timeout (${timeout}ms)` }));
  }, timeout);

  pendingCommands.set(id, { res, timer, startTime, action });

  try {
    connectedExt.send(message);
  } catch (e) {
    clearTimeout(timer);
    pendingCommands.delete(id);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to send to extension' }));
  }
}

function completeCommand(id, data) {
  const entry = pendingCommands.get(id);
  if (!entry) return;
  const { res, timer, startTime, action } = entry;
  clearTimeout(timer);
  pendingCommands.delete(id);
  const elapsed = Date.now() - startTime;
  successCount++;
  totalResponseMs += elapsed;
  lastSuccessTime = Date.now();
  log(`✓ ${action} #${id} ${elapsed}ms`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ==================== WebSocket 服务 ====================
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
  log('✅ Chrome 扩展已连接');
  connectedExt = ws;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.id && pendingCommands.has(message.id)) {
        completeCommand(message.id, message.result || message);
      }
      else if (message.type === 'tabsInfo') {
        lastTabs = message.tabs || [];
      }
    } catch (error) {
      log(`❌ 消息解析错误: ${error.message}`);
    }
  });

  ws.on('close', () => {
    log('❌ Chrome 扩展已断开');
    if (connectedExt === ws) {
      connectedExt = null;
      lastTabs = []; // 🔴 断开即清空缓存，避免 /tabs 返回过期数据绕过按需恢复（2026-08-25 实测踩坑）
    }
  });

  ws.on('error', (error) => {
    log(`❌ WebSocket 错误: ${error.message}`);
  });
});

// ==================== 心跳监控 ====================
let lastDisconnectTime = null;
setInterval(() => {
  if (!connectedExt || connectedExt.readyState !== WebSocket.OPEN) {
    if (!lastDisconnectTime) {
      lastDisconnectTime = Date.now();
      log('⚠️ 扩展已断开，等待重连...');
    }
    const elapsed = (Date.now() - lastDisconnectTime) / 1000;
    if (elapsed > 0 && elapsed % 60 < 1) {
      log(`⚠️ 扩展已断开 ${Math.floor(elapsed)}s`);
    }
  } else {
    if (lastDisconnectTime) {
      const downtime = (Date.now() - lastDisconnectTime) / 1000;
      log(`✅ 扩展已重连（断连 ${Math.floor(downtime)}s）`);
      lastDisconnectTime = null;
    }
  }
}, 10000);


// ==================== 启动 ====================
httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  log(`🚀 HTTP: http://127.0.0.1:${HTTP_PORT}`);
  log(`🚀 WebSocket: ws://127.0.0.1:${WS_PORT}`);
  log('🔑 Auth: Bearer token required (except /health)');
  log('等待 Chrome 扩展连接...');
});

process.on('SIGINT', () => {
  log('正在关闭...');
  httpServer.close();
  wss.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('收到终止信号，正在关闭...');
  httpServer.close();
  wss.close();
  process.exit(0);
});