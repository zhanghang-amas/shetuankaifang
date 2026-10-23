# 社团 DeepSeek 助手

给社团成员用的 DeepSeek 网页聊天界面：**登录后才能用**，额度由社团统一提供，每个人 500 万 tokens，用超了自动拦截。

- 线上地址：<https://zhanghang-amas.github.io/shetuankaifang/>
- 后端：`server/`（Node，零依赖），部署到 Render 等平台；账号和 Key 都在后端

> 第一次打开会要求登录。账号找社团管理员要，API Key 不需要自己准备。

---

## 架构

```
浏览器（GitHub Pages 上的静态页面）
   │  1. POST /api/login  → 拿到 Bearer token
   │  2. POST /api/chat   → 带 token 请求（浏览器里没有 Key）
   ▼
社团后端（server/server.mjs，部署在 Render）
   ├─ 校验 token、检查剩余额度
   ├─ 用服务器上的 DeepSeek Key 调用 api.deepseek.com
   └─ 按上游返回的 usage 扣掉该账号的 token 额度
```

关键点：

- **Key 不出服务器**：浏览器里没有 Key，F12 也翻不到。
- **额度在服务端算**：按 DeepSeek 返回的 `usage`（prompt + completion）逐次累加，改前端也没用。
- **登录用 Bearer token**：不用 Cookie，所以 Pages（`github.io`）和后端（`onrender.com`）跨域也能正常登录。

| 文件 | 作用 |
| --- | --- |
| `index.html` `style.css` `app.js` | 聊天界面 |
| `auth.css` | 登录门 / 账号面板样式 |
| `runtime.js` | 运行环境适配：判断「服务端模式」还是「纯静态模式」，处理登录、token、额度刷新 |
| `config.js` | **后端地址**写在这里（`window.DS_API_BASE`） |
| `worker/worker.js` | **Cloudflare Worker 版后端**（免费、不用绑卡），推荐用这个 |
| `worker/README.md` | Worker 部署步骤（全网页操作，约 10 分钟） |
| `server/server.mjs` | Node 版后端（功能相同），适合 VPS / Docker / 有卡的平台 |
| `server/DEPLOY.md` | Node 版的部署步骤（Render / VPS / Docker） |

---

## 使用

1. 打开 <https://zhanghang-amas.github.io/shetuankaifang/>
2. 输入社团给的账号密码
3. 右上角显示「剩余 xxx」，鼠标悬停可看「已用 / 上限」
4. 点右上角齿轮 →「账号」，可以看已用多少、还剩多少、退出登录

额度用完后再发消息会提示「额度已经用完了」，需要管理员重置。

对话记录只存在你自己的浏览器（localStorage），换设备看不到，也不会同步到服务器。

---

## 管理账号和额度

账号写在环境变量 `ACCOUNTS` 里，格式 `用户名:密码:额度`，多个账号用逗号分隔：

```
ACCOUNTS=测试:123456:5000000,张三:zhangsan-pass:5000000,李四:lisi-pass:3000000
```

不写额度就用 `DEFAULT_QUOTA`（默认 500 万）。

管理员接口（需要 `ADMIN_PASSWORD`，用 `X-Admin-Password` 请求头传）：

```powershell
# 看所有人的用量
Invoke-RestMethod https://你的服务.onrender.com/api/admin/users `
  -Headers @{ 'X-Admin-Password' = '管理员口令' }

# 把「测试」的已用额度清零
Invoke-RestMethod https://你的服务.onrender.com/api/admin/reset -Method Post `
  -Headers @{ 'X-Admin-Password' = '管理员口令'; 'Content-Type' = 'application/json' } `
  -Body '{"username":"测试"}'

# 改某个人的上限（1000 万）
Invoke-RestMethod https://你的服务.onrender.com/api/admin/quota -Method Post `
  -Headers @{ 'X-Admin-Password' = '管理员口令'; 'Content-Type' = 'application/json' } `
  -Body '{"username":"测试","quota":10000000}'
```

⚠️ 免费平台重启会丢磁盘，用量可能回到 0。要严格统计就配 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`，详见 [server/DEPLOY.md](server/DEPLOY.md)。

---

## 部署后端

两条路，功能一样，选一条：

| 方案 | 需要信用卡 | 说明 |
| --- | --- | --- |
| **Cloudflare Worker**（推荐） | 不要 | 免费计划，全网页操作，见 [worker/README.md](worker/README.md) |
| Node 版（Render / VPS / Docker） | Render 新账号可能要 | 见 [server/DEPLOY.md](server/DEPLOY.md) |

部署完成后，把服务地址填进 `config.js`：

```js
window.DS_API_BASE = 'https://你的服务.onrender.com';
```

提交后 Pages 会自动重新发布，之后打开线上地址就是「先登录、再用」。

---

## 备用模式：每个人用自己的 Key

如果 `DS_API_BASE` 留空，页面会退回纯静态模式：浏览器直连 `api.deepseek.com`，每个访客在「设置」里填自己的 Key，存在本地浏览器。

适合你不想管后端、也不介意每个人自备 Key 的情况。要恢复这种模式，把 `config.js` 里的地址清空即可。

---

## 本地跑

```bash
# 后端（需要 Node 20+）
ACCOUNTS="测试:123456:5000000" ADMIN_PASSWORD="管理口令" \
DEEPSEEK_API_KEY="sk-..." node server/server.mjs
# 打开 http://127.0.0.1:3000
```

Windows PowerShell 用 `$env:ACCOUNTS='...'` 的写法。

---

## 安全提醒

- 示例密码比较弱，正式用之前建议换成强密码（改 `ACCOUNTS` 环境变量即可）。
- `server/data/` 里有 Key 和账号哈希，已被 `.gitignore` 排除，**不要提交**。
- 管理员口令一旦泄露，别人就能重置额度、改上限，注意保管。