// ==================== Agent Bridge 按需恢复看门狗 v1.0 (2026-08-25) ====================
// 设计原则（替代旧的巡逻式窗口守护）：
//   1. 按需恢复 —— 平时扩展断连不处理；仅当真实业务请求到达且等待重连失败时才拉起 Chrome。
//      用户日常开关 Chrome 零打扰（旧版把正常退出当故障，40s 内强制拉回）。
//   2. 精准击杀 —— 只杀自动化专用 profile（chrome-profiles/real）的 Chrome 实例，
//      永不触碰用户日常 Chrome（旧版 killall "Google Chrome" 全灭，包括正在用的窗口）。
//   3. 熔断器 —— 连续恢复失败达阈值后停止自动拉起并飞书告警等人工；
//      杜绝 2026-06 式「扩展连不上 → 每分钟重启」10 天 1.1 万次循环。扩展重连成功自动复位。
//   4. 飞书告警复用 ~/.hermes/.env 的 FEISHU_APP_ID/SECRET + 定时任务推送群（与额度哨兵同通道）。

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE_DIR = path.join(os.homedir(), '.hermes/chrome-profiles/real');
const EXTENSION_DIR = path.join(os.homedir(), '.hermes/extensions/agent-bridge/extension');
// 🔴 Chrome 149+ 不带 --profile-directory 会停在 profile-picker，扩展永远连不上（2026-06 事故燃料之一）
const LAUNCH_ARGS = [
  '--user-data-dir=' + PROFILE_DIR,
  '--profile-directory=Default',
  '--no-first-run',
  '--no-default-browser-check',
  '--load-extension=' + EXTENSION_DIR,
];

const RECOVERY_COOLDOWN_MS = parseInt(process.env.WD_COOLDOWN_MS || '60000', 10);       // 两次恢复尝试最小间隔
const RECOVERY_WAIT_MS = parseInt(process.env.WD_WAIT_MS || '15000', 10);               // 单次恢复后等待扩展回连上限（下游 HTTP 超时 30s，需留余量）
const CIRCUIT_THRESHOLD = parseInt(process.env.WD_THRESHOLD || '3', 10);                // 连续失败 N 次 → 熔断
const CIRCUIT_RESET_MS = parseInt(process.env.WD_CIRCUIT_RESET_MS || String(30 * 60000), 10); // 熔断 30 分钟后半开：允许再试一次
const ALERT_MIN_INTERVAL_MS = parseInt(process.env.WD_ALERT_INTERVAL_MS || String(60 * 60000), 10); // 告警最小间隔，防轰炸
// 告警目标群（需配置 WD_FEISHU_CHAT_ID 环境变量，未配置则告警静默降级）
const FEISHU_ALERT_CHAT_ID = process.env.WD_FEISHU_CHAT_ID || '';

let lastRecoveryAttempt = 0;
let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenedAt = 0;
let lastAlertAt = 0;

function wdLog(msg) {
  console.log(`[watchdog] ${new Date().toISOString()} ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 飞书卡片告警 ----------
async function sendFeishuAlert(reason) {
  if (!FEISHU_ALERT_CHAT_ID) {
    wdLog('未配置 WD_FEISHU_CHAT_ID，跳过告警发送');
    return;
  }
  const now = Date.now();
  if (now - lastAlertAt < ALERT_MIN_INTERVAL_MS) {
    wdLog('告警冷却中，跳过发送');
    return;
  }
  lastAlertAt = now;
  try {
    const envVars = {};
    const envPath = path.join(os.homedir(), '.hermes/.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        envVars[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
    if (!envVars.FEISHU_APP_ID || !envVars.FEISHU_APP_SECRET) throw new Error('.env 缺 FEISHU 凭证');

    const post = (urlPath, data, token) => new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = https.request({
        hostname: 'open.feishu.cn', path: urlPath, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        timeout: 10000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    });

    const tokRes = await post('/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: envVars.FEISHU_APP_ID, app_secret: envVars.FEISHU_APP_SECRET });
    const token = tokRes && tokRes.tenant_access_token;
    if (!token) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(tokRes).slice(0, 200));

    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: { tag: 'plain_text', content: '🚨 Agent Bridge 自动恢复熔断' },
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md',
          content: `**连续 ${consecutiveFailures} 次自动拉起自动化 Chrome 失败，已熔断停止重试。**\n**原因：** ${reason}\n**影响：** 下游任务（GLaDOS 签到 / 观影网 / 淘宝比价 / 额度哨兵实时刷新）在桥接恢复前会失败。\n**恢复方法：** 终端执行 \`bash ~/.hermes/skills/browser/agent-bridge/scripts/restart-real-chrome.sh\`，扩展连上后熔断自动复位。` } },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text',
          content: `Agent Bridge watchdog · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` }] },
      ],
    };
    const resp = await post('/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: FEISHU_ALERT_CHAT_ID, msg_type: 'interactive', content: JSON.stringify(card) }, token);
    wdLog('飞书告警已发送 code=' + (resp && resp.code));
  } catch (e) {
    wdLog('飞书告警发送失败: ' + e.message);
  }
}

// ---------- Chrome 进程操作 ----------
function chromeProfileRunning() {
  // 只检测带自动化 profile 参数的 Chrome 进程；pgrep 无匹配时退出码非 0 → 视为未运行
  try {
    return execSync("pgrep -f 'chrome-profiles/real'", { encoding: 'utf8', timeout: 3000 }).trim().length > 0;
  } catch {
    return false;
  }
}

function startChrome() {
  const child = spawn(CHROME_BIN, LAUNCH_ARGS, { detached: true, stdio: 'ignore' });
  child.unref();
}

function killProfileChrome() {
  // 🔴 精准击杀：只杀自动化实例，绝不 killall 全局 Chrome
  try { execSync("pkill -f 'chrome-profiles/real'", { timeout: 5000 }); } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
  }
}

// ---------- 工厂：注入连接状态检测 ----------
function createWatchdog(deps) {
  const isConnected = deps.isConnected;

  function resetCircuitBreaker(reason) {
    if (!circuitOpen) return;
    circuitOpen = false;
    consecutiveFailures = 0;
    wdLog('🔓 熔断已复位: ' + reason);
  }

  async function tripIfNeeded(reason) {
    if (consecutiveFailures >= CIRCUIT_THRESHOLD && !circuitOpen) {
      circuitOpen = true;
      circuitOpenedAt = Date.now();
      wdLog('🚫 达到熔断阈值，停止自动恢复');
      await sendFeishuAlert(reason);
    }
  }

  // 主入口：业务请求到达且扩展断连时调用。返回 true 表示可以继续执行命令。
  async function ensureBridgeAvailable(action) {
    if (isConnected()) {
      consecutiveFailures = 0;
      resetCircuitBreaker('扩展已重连');
      return true;
    }

    const now = Date.now();
    if (circuitOpen && now - circuitOpenedAt < CIRCUIT_RESET_MS) {
      wdLog(`熔断中，跳过恢复 (${action})`);
      return false;
    }
    if (circuitOpen) wdLog('熔断半开期，允许尝试一次恢复');

    if (now - lastRecoveryAttempt < RECOVERY_COOLDOWN_MS) {
      wdLog(`恢复冷却中 (${action})，跳过`);
      return false;
    }
    lastRecoveryAttempt = now;

    try {
      if (!chromeProfileRunning()) {
        wdLog(`🔧 [${action}] 自动化 Chrome 未运行，拉起...`);
        startChrome();
      } else {
        wdLog(`🔧 [${action}] 进程在但扩展未连，精准重启自动化实例...`);
        killProfileChrome();
        await sleep(2000);
        startChrome();
      }

      const deadline = Date.now() + RECOVERY_WAIT_MS;
      while (Date.now() < deadline) {
        if (isConnected()) break;
        await sleep(500);
      }

      if (isConnected()) {
        consecutiveFailures = 0;
        resetCircuitBreaker('恢复成功');
        wdLog(`✅ [${action}] 桥接已恢复`);
        return true;
      }

      consecutiveFailures++;
      wdLog(`❌ [${action}] 恢复后仍未连接（连续失败 ${consecutiveFailures}/${CIRCUIT_THRESHOLD}）`);
      await tripIfNeeded('连续 ' + consecutiveFailures + ' 次按需恢复失败（拉起后 ' + RECOVERY_WAIT_MS / 1000 + 's 内扩展未回连）');
      return false;
    } catch (e) {
      consecutiveFailures++;
      wdLog(`恢复异常: ${e.message}（连续失败 ${consecutiveFailures}/${CIRCUIT_THRESHOLD}）`);
      await tripIfNeeded('恢复过程异常: ' + String(e.message || e).slice(0, 120));
      return false;
    }
  }

  function status() {
    return { circuitOpen, consecutiveFailures };
  }

  return { ensureBridgeAvailable, resetCircuitBreaker, chromeProfileRunning, status };
}

module.exports = { createWatchdog };
