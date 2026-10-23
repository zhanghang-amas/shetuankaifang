# 把 Node 服务版部署到公网

`server/` 是一个零依赖的 Node 服务：`server.mjs`（SSE 转发 + 访问密码 + 健康检查）加上仓库根目录的静态页面，不需要 `npm install`。

什么时候需要它？

- 想让社团成员**共用一个 Key**，用访问密码拦一道；
- 不想让 Key 出现在任何人的浏览器里。

只想白嫖 GitHub Pages 的话，看仓库根目录的 [README.md](../README.md) 就够了。

## 部署前必须做的三件事

| 环境变量 | 作用 | 示例 |
| --- | --- | --- |
| `ACCESS_PASSWORD` | 访问密码，公网必填 | 一串只有你知道的强密码 |
| `DEEPSEEK_API_KEY` | DeepSeek Key（也可进页面后在「设置」里填） | `sk-...` |
| `HOST` | 平台要求监听所有网卡时设为 `0.0.0.0` | `0.0.0.0` |

> ⚠️ 不设 `ACCESS_PASSWORD` 就公开部署，任何人打开链接都能消耗你的 DeepSeek 余额。

HTTPS 环境下再加 `COOKIE_SECURE=1`，让登录 Cookie 只走加密连接。

## 方案 A：Render（免费，最省事）

1. 把这个仓库推到 GitHub（`server/data/` 不要提交，`.gitignore` 已经排除了）。
2. Render → New → Web Service → 选择仓库。
3. Root Directory 填 `server`，Runtime 选 Node，Build Command 留空，Start Command 填 `node server.mjs`。
4. Environment 添加：
   - `HOST=0.0.0.0`
   - `ACCESS_PASSWORD=你的密码`
   - `DEEPSEEK_API_KEY=sk-...`
   - `COOKIE_SECURE=1`
   - `PUBLIC_DIR=/opt/render/project/src`（静态页面在仓库根目录，按平台实际路径调整；不确定就留空，服务会自动找上一级目录）
5. Health Check Path 填 `/api/health`。
6. 部署完成后打开域名，先输入访问密码。

免费实例会休眠，首次打开较慢；特别长的流式回答可能被平台超时中断。

## 方案 B：Railway / Zeabur / Fly.io

与方案 A 相同：Node 服务，启动命令 `node server.mjs`（工作目录 `server/`），环境变量一致。

## 方案 C：VPS + Docker + Caddy（最稳）

在**仓库根目录**执行（Dockerfile 在 `server/`，构建上下文是仓库根）：

```bash
docker build -f server/Dockerfile -t deepseek-chat .
docker run -d --name deepseek-chat --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e HOST=0.0.0.0 \
  -e ACCESS_PASSWORD='换成强密码' \
  -e DEEPSEEK_API_KEY='sk-...' \
  -e COOKIE_SECURE=1 \
  -v deepseek-data:/app/server/data \
  deepseek-chat
```

Caddy 反代（自动 HTTPS，默认不缓冲 SSE）：

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx 反代记得关闭缓冲，否则流式输出会卡住：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## 方案 D：Cloudflare Tunnel（不买服务器，电脑要开机）

```bash
node server/server.mjs
cloudflared tunnel --url http://127.0.0.1:3000
```

会得到一个临时 `trycloudflare.com` 地址，适合自己临时用。长期使用建议命名隧道 + Cloudflare Access（邮箱验证）。

## 安全清单

- [ ] 设置了 `ACCESS_PASSWORD`，或套了 Cloudflare Access / Caddy basic_auth
- [ ] 没有把 `server/data/`（含 API Key）上传到公开仓库
- [ ] DeepSeek 控制台里设置了余额或用量上限
- [ ] HTTPS 下设置了 `COOKIE_SECURE=1`
- [ ] 定期查看 `server/data/access.log`

## 常见问题

- **页面打不开 / 502**：确认进程监听的是 `0.0.0.0`（平台）或 `127.0.0.1`（反代后面）。
- **静态页面 404**：`PUBLIC_DIR` 没指对，或者仓库根目录的 `index.html` 没随仓库一起上去。
- **回答不是流式的**：反代开了缓冲，关掉 `proxy_buffering`，Caddy 默认即可。
- **登录后又跳回密码页**：反向代理改写了协议时请确认 Cookie 没被丢弃。
- **健康检查失败**：健康检查路径是 `/api/health`，它不需要登录。
