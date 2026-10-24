# 用 Cloudflare Pages 跑后端（免费、不用信用卡）

GitHub Pages 只能放静态文件，登录和额度必须有个后端。这个仓库里有两份等价实现：

| 目录 | 运行时 | 部署方式 | 国内能不能访问 |
| --- | --- | --- | --- |
| `functions/` + `worker/worker.js` | Cloudflare **Pages Functions** | 连 GitHub 仓库，自动构建 | ✅ `*.pages.dev` 可以 |
| `worker/worker.js` 单独用 | Cloudflare **Workers** | 手动建 Worker、粘代码 | ❌ `*.workers.dev` 被墙 |

> **推荐 Pages**：不用手抄代码、不用装工具、域名在国内能打开。下面全是 Pages 的步骤。

---

## 为什么不是 Workers

`*.workers.dev` 在国内被 DNS 污染（解析到 199.59.150.44，连不上）。Pages 用的是 `*.pages.dev`，走的是另一组 Cloudflare 节点，实测可以访问。

---

## 部署步骤（全网页，约 10 分钟）

### 1. 注册 Cloudflare

打开 <https://dash.cloudflare.com/sign-up>，邮箱注册，**不需要信用卡**。

### 2. 建 Pages 项目

1. 左侧 **Workers & Pages** → **Create**
2. 选 **Pages** 标签 → **Connect to Git**
3. 授权 GitHub → 选仓库 `shetuankaifang` → **Begin setup**

### 3. 构建设置（照抄）

| 字段 | 值 |
| --- | --- |
| Project name | `shetuankaifang`（决定网址 `shetuankaifang.pages.dev`，被别人占了会自动加后缀） |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `mkdir -p dist && cp *.html *.css *.js *.svg dist/` |
| Build output directory | `dist` |

点 **Save and Deploy**，等 1-2 分钟。

> 这个构建命令只是把静态页面拷进 `dist`；`functions/` 目录会被 Cloudflare 自动识别成 Functions，不用管。

### 4. 加环境变量

项目页面 → **Settings** → **Variables and Secrets**（或 Environment variables）→ **Add**：

| 变量名 | 类型 | 值 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Secret | 你的 `sk-...` |
| `ACCOUNTS` | Text | `测试:123456:5000000`（多个账号用英文逗号隔开） |
| `ADMIN_PASSWORD` | Secret | 你自己定的管理员口令 |
| `SESSION_SECRET` | Secret | 随机长串，比如 `x7Kp2LmQ9vRt4Bz8` |

### 5. 绑定 KV（存每个人的额度）

1. Cloudflare 左侧 → **Storage & Databases** → **KV** → **Create a namespace** → 名字 `shetuankaifang`
2. 回到 Pages 项目 → **Settings** → **Functions** → **KV namespace bindings** → **Add binding**
3. Variable name 填 **`USERS`**（必须大写，一模一样）→ 选刚建的 `shetuankaifang` → **Save**

### 6. 重新部署一次

改了绑定必须重新发布才生效：项目页面 → **Deployments** → 最新那条右侧 `...` → **Retry deployment**（或随便提交一次代码触发构建）。

### 7. 验证

浏览器打开：

```
https://shetuankaifang.pages.dev/api/health
```

期望返回：

```json
{"ok":true,"mode":"server","storage":"kv"}
```

- `"storage":"kv"` → KV 绑定成功
- `"storage":"memory"` → 第 5 步没生效，检查变量名是不是大写的 `USERS`，然后重做第 6 步

再打开 `https://shetuankaifang.pages.dev/`，应该直接是登录页（这个域名同时托管了前端和后端，同源，不会有跨域问题）。

---

## 账号格式

`用户名:密码:额度`，多个用英文逗号隔开，额度不写就是默认 500 万：

```
测试:123456:5000000,张三:zhangsan2026:5000000,李四:lisi2026
```

- 账号**只在第一次创建**，之后改 `ACCOUNTS` 不会覆盖已有账号（避免把用量冲掉）
- 加人：往 `ACCOUNTS` 追加后重新部署，新账号会被补建

## 管理员接口

请求头带 `X-Admin-Password`，值就是 `ADMIN_PASSWORD`。

```powershell
$base = 'https://shetuankaifang.pages.dev'
$h = @{ 'X-Admin-Password' = '你的管理员口令' }

# 看所有人用量
Invoke-RestMethod "$base/api/admin/users" -Headers $h

# 清零某人（不传 username 就是全部清零）
Invoke-RestMethod "$base/api/admin/reset" -Method Post `
  -Headers ($h + @{ 'Content-Type' = 'application/json' }) -Body '{"username":"测试"}'

# 改上限
Invoke-RestMethod "$base/api/admin/quota" -Method Post `
  -Headers ($h + @{ 'Content-Type' = 'application/json' }) -Body '{"username":"测试","quota":10000000}'
```

---

## 免费额度够不够

| 项目 | 免费额度 | 我们怎么用 |
| --- | --- | --- |
| Pages 构建 | 500 次/月 | 只有改代码才构建 |
| Functions 请求 | 10 万次/天 | 一条消息 2 个请求，够用 |
| Functions CPU | 每次 10ms | 只有登录做密码哈希（已压到 2000 次迭代），其余是转发 |
| KV 读 | 10 万次/天 | 每个请求 1 次 |
| KV 写 | 1000 次/天 | 每轮对话 1 次；一天聊超过 1000 轮再升级 |

## 注意事项

- **密码哈希是 PBKDF2 2000 次**（受免费版 10ms CPU 限制）。密码别用 123456，最好 8 位以上混合字符。
- KV 里存三样东西：账号哈希、已用额度、每个人的对话记录（key 前缀 `history:`）。**不存 DeepSeek Key**（Key 只在环境变量里）。
- 如果哪天 `pages.dev` 也打不开了，可以给它绑一个自己的域名（Cloudflare 免费支持自定义域名）。

## 本地验证（可选）

没有 wrangler 也能跑：仓库外的测试目录里有 `pages-fn-harness.mjs`，把 Functions 入口套一个 HTTP 服务器模拟：

```bash
node _e2e/mock-upstream.mjs      # 假的 DeepSeek 上游
node _e2e/pages-fn-harness.mjs   # 模拟 Cloudflare 运行时
node _e2e/api-check.mjs          # 29 项接口测试
```