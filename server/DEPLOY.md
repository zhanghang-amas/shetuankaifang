# 部署社团后端（Render / VPS / Docker）

`server/` 是一个零依赖的 Node 服务，负责三件事：

1. 账号登录（用户名 + 密码，scrypt 加盐哈希）
2. 每个账号的 token 额度（默认 500 万），按 DeepSeek 返回的 `usage` 记账
3. 用服务器上的 Key 转发 SSE，浏览器拿不到 Key

静态页面（仓库根目录）继续放在 GitHub Pages，通过 `config.js` 里的 `DS_API_BASE` 指向这个后端。

---

## 方案 A：Render 免费实例（推荐，约 5 分钟）

> **一键版**：仓库根目录带了 `render.yaml`。Render → **New +** → **Blueprint** → 选仓库 → 按提示填 `DEEPSEEK_API_KEY`、`ACCOUNTS`、`ADMIN_PASSWORD` 三个值 → 部署完成。`SESSION_SECRET` 会自动生成，服务名默认 `shetuankaifang`。
> 想手动配也行，按下面步骤走。


1. 打开 <https://render.com> → 用 GitHub 账号登录
2. 右上角 **New +** → **Web Service** → 选仓库 `shetuankaifang`
3. 填写：

   | 项目 | 值 |
   | --- | --- |
   | Name | `shetuankaifang`（服务名决定网址，重名会自动加后缀） |
   | Language | Node |
   | **Root Directory** | 留空 |
   | Build Command | 留空（没有依赖，不需要 `npm install`） |
   | Start Command | `node server/server.mjs` |
   | Instance Type | Free |
   | Health Check Path | `/api/health` |

4. 往下展开 **Environment Variables**，逐条添加：

   | Key | 值 |
   | --- | --- |
   | `HOST` | `0.0.0.0` |
   | `DEEPSEEK_API_KEY` | 你的 DeepSeek Key（`sk-...`） |
   | `ACCOUNTS` | 账号列表，见下面「账号格式」 |
   | `ADMIN_PASSWORD` | 你自己定的管理员口令 |
   | `SESSION_SECRET` | 随便一长串随机字符（不设的话重启后所有人要重新登录） |

   `ACCOUNTS` 格式：`用户名:密码:额度`，多个用英文逗号分隔，额度可省略（默认 500 万）：

   ```
   测试:123456:5000000,张三:zhangsan2026:5000000,李四:lisi2026
   ```

5. 点 **Create Web Service**，等 1-2 分钟，地址形如 `https://shetuankaifang.onrender.com`
6. 验证后端：

   ```powershell
   Invoke-RestMethod https://shetuankaifang.onrender.com/api/health
   # 期望: ok=True  mode=server
   ```

7. 把这个地址填进仓库的 `config.js`，提交后 Pages 会自动重新发布：

   ```js
   window.DS_API_BASE = 'https://shetuankaifang.onrender.com';
   ```

> 免费实例 15 分钟没人用会休眠，第一次打开要等 30-60 秒唤醒。

---

## 账号与额度

- 账号只在**第一次启动**时按 `ACCOUNTS` 创建；之后改环境变量不会覆盖已有账号（避免把线上用量冲掉）。
- 想加人：往 `ACCOUNTS` 里追加，重新部署，新账号会被补建。
- 想改密码：删掉 `server/data/users.json`（或用 Upstash 时删远端 key）后重新部署，会按 `ACCOUNTS` 重建。
- 想改额度/清零：用管理员接口，见下。

### 管理员接口

需要环境变量 `ADMIN_PASSWORD`，请求头带 `X-Admin-Password`。

```powershell
$base = 'https://shetuankaifang.onrender.com'
$h = @{ 'X-Admin-Password' = '你的管理员口令' }

# 所有人用量
Invoke-RestMethod "$base/api/admin/users" -Headers $h

# 清零某人（不传 username 就是全部清零）
Invoke-RestMethod "$base/api/admin/reset" -Method Post -Headers ($h + @{ 'Content-Type' = 'application/json' }) -Body '{"username":"测试"}'

# 改上限
Invoke-RestMethod "$base/api/admin/quota" -Method Post -Headers ($h + @{ 'Content-Type' = 'application/json' }) -Body '{"username":"测试","quota":10000000}'
```

---

## 用量持久化（重要）

Render 免费实例**没有持久磁盘**，服务重启 / 重新部署后 `server/data/users.json` 会丢，大家的已用额度会回到 0。

要不要在意：

- 只是防止「某个人把额度用超」→ 够用，重启概率不高。
- 想严格累计几个月 → 二选一：
  1. 升级 Render 并挂持久磁盘；或
  2. 用免费的 Upstash Redis（<https://upstash.com>，GitHub 登录即用）：
     - 建一个 Redis 数据库 → 复制 **REST URL** 和 **REST Token**
     - 在 Render 里加两个环境变量：`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`

     配好后，账号和用量都存 Redis，重启不丢。

---

## 方案 B：VPS + Docker + Caddy

在**仓库根目录**执行（Dockerfile 在 `server/`）：

```bash
docker build -f server/Dockerfile -t shetuankaifang .
docker run -d --name shetuankaifang --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e HOST=0.0.0.0 \
  -e DEEPSEEK_API_KEY='sk-...' \
  -e ACCOUNTS='测试:123456:5000000' \
  -e ADMIN_PASSWORD='管理员口令' \
  -e SESSION_SECRET='一串随机字符' \
  -v shetuankaifang-data:/app/server/data \
  shetuankaifang
```

Caddy 反代（自动 HTTPS，默认不缓冲 SSE）：

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx 记得关缓冲，否则流式输出会卡住：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

---

## 环境变量总表

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 社团共用的 Key，只存在服务器 |
| `ACCOUNTS` | 是 | `用户名:密码:额度`，逗号分隔；不填会建一个默认账号 |
| `ADMIN_PASSWORD` | 建议 | 管理员接口口令 |
| `SESSION_SECRET` | 建议 | 登录令牌签名密钥，固定它重启不掉登录 |
| `DEFAULT_QUOTA` | 否 | 没写额度时的上限，默认 `5000000` |
| `ALLOWED_ORIGINS` | 否 | 跨域白名单，默认已含 `https://zhanghang-amas.github.io` |
| `PUBLIC_DIR` | 否 | 静态页面目录，默认仓库根目录 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 否 | 用量持久化 |
| `HOST` / `PORT` | 否 | 平台一般要求 `HOST=0.0.0.0`，端口由平台注入 |

---

## 排错

- **登录报「无法连接服务器」**：`config.js` 里的地址写错了，或者后端还在休眠（等 30 秒重试）。
- **登录成功但发消息 502**：服务器上的 `DEEPSEEK_API_KEY` 无效或余额不足。
- **浏览器控制台 CORS 报错**：`ALLOWED_ORIGINS` 里没有当前域名，加上再重启。
- **改了 ACCOUNTS 没生效**：账号只创建一次，改密码要清 `users.json` 或换 Upstash 数据。
- **额度不对**：确认平台是否重启过（免费实例会丢磁盘），要严格就上 Upstash。