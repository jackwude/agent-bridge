# Agent Bridge

通过 Chrome 扩展 + 本地 HTTP API，让 AI Agent 操控你**真实的** Chrome 浏览器（保留登录态、Cookie、扩展生态），反爬场景下远比无头浏览器可靠。

```
Agent (curl/HTTP) ──► Server (localhost:18900)
                          │  WebSocket (localhost:18910) + Bearer Token 认证
                          ▼
                    Chrome 扩展 (MV3 Service Worker + Content Script)
```

## 核心特性

- **真实浏览器**：复用登录态与 Cookie，淘宝/小红书等反爬站点可用
- **按需恢复看门狗**：平时零打扰；仅当业务请求到达且扩展断连时才自动拉起 Chrome（含熔断器与飞书告警）
- **精准进程管理**：只操作自动化专用 profile 的 Chrome 实例，绝不误杀日常浏览器窗口
- **P0 级页面交互**：`click` / `fill` / `type` / `waitFor`（绕过 React 受控组件、模拟完整鼠标事件链）
- **httpOnly Cookie 读取**：为签到脚本等提供 API 级认证材料
- **可观测性**：`/health` 暴露连接状态、请求统计、熔断器状态

## 目录结构

```
server/       Node.js HTTP+WebSocket 服务端（含 watchdog.js 按需恢复看门狗）
extension/    Chrome MV3 扩展（background.js + content.js）
deploy/       launchd plist 模板与环境变量说明
```

## 快速开始

### 1. 安装服务端

```bash
cd server && npm install && node index.js
# 首次运行会自动生成 ~/.hermes/agent-bridge-token
curl -s http://localhost:18900/health   # 验证
```

### 2. 加载 Chrome 扩展

打开 `chrome://extensions/` → 开发者模式 → 「加载已解压的扩展程序」→ 选择本仓库 `extension/` 目录。

> ⚠️ Chrome 148+ 中 `--load-extension` 命令行参数对 MV3 unpacked 扩展会静默失效，手动 UI 加载是唯一可靠方式。

### 3. 使用

```bash
TOKEN=$(cat ~/.hermes/agent-bridge-token)
AUTH="Authorization: Bearer $TOKEN"

curl -s http://localhost:18900/tabs -H "$AUTH"                      # 列出标签页
curl -s -X POST http://localhost:18900/navigate -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'                                 # 导航
curl -s -X POST http://localhost:18900/click -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"selector":"button.submit"}'                                  # 点击元素
```

## API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查（无需认证）：连接/统计/熔断器状态 |
| `/tabs` | GET | 标签页列表 |
| `/navigate` | POST | 页面导航（不带 tabId 会新开标签页）|
| `/execute` | POST | 注入执行任意 JS（返回 JSON 编码的结果）|
| `/screenshot` | POST | 截图（返回 dataUrl）|
| `/click` `/fill` `/type` | POST | 元素交互（自动滚动+完整事件链）|
| `/waitFor` | POST | 等待元素出现（替代盲 sleep）|
| `/close` | POST | 关闭标签页 |
| `/cookies` | POST | 读取指定域名的 httpOnly Cookie |
| `/reload` | POST | 重载扩展 |

所有端点除 `/health` 外均需 `Authorization: Bearer <token>`。

## 按需恢复看门狗（watchdog.js）

设计原则：**平时不打扰用户，需要时才自愈，故障时敢报警。**

- 平时扩展断连不处理——用户随意开关 Chrome 不受任何干扰
- 仅当业务请求到达、且等待自然重连失败后，才拉起/精准重启自动化实例
- 只匹配自动化 profile 参数的进程（`pkill -f 'chrome-profiles/real'`），永不 killall 全局 Chrome
- 连续 3 次恢复失败 → 熔断停止重试 + 飞书卡片告警；扩展重连成功自动复位
- 启动命令强制携带 `--profile-directory=Default`（Chrome 149+ 无此参数会卡在 profile picker）

可通过环境变量调参：

```bash
WD_COOLDOWN_MS=60000          # 两次恢复尝试最小间隔
WD_WAIT_MS=15000              # 恢复后等待扩展回连上限
WD_THRESHOLD=3                # 连续失败多少次触发熔断
WD_CIRCUIT_RESET_MS=1800000   # 熔断半开时间
WD_ALERT_INTERVAL_MS=3600000  # 告警最小间隔
WD_FEISHU_CHAT_ID=oc_xxx      # 飞书告警目标群
```

飞书告警凭证从 `~/.hermes/.env` 读取（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）；未配置时告警静默降级，不影响主流程。

## 部署为系统服务（macOS launchd）

参考 `deploy/com.hermes.agent-bridge.plist`：

```bash
cp deploy/com.hermes.agent-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hermes.agent-bridge.plist
```

`RunAtLoad` + `KeepAlive` 保证开机自启与崩溃拉起。日志写入 `~/.hermes/logs/agent-bridge.log`。

## 已知限制与坑点

- **MV3 Service Worker 依赖可见窗口**：Chrome 所有窗口关闭后扩展断连（这正是按需恢复存在的原因）
- **chrome:// 页面不可注入**：内部页面无法 execute/click
- **CSP 严格站点**（Google 系）：`/execute` 返回 null 但不报错；改用 `/waitFor`+`/click`
- **dispatchEvent 是非可信事件**（isTrusted=false）：Google OAuth 确认按钮点不动
- **复杂电商页面**：`querySelectorAll`+循环易超时，优先用 `document.body.innerText` 取全文
- **截图**：部分站点（淘宝/豆瓣）会 `image readback failed`，文本提取更稳
