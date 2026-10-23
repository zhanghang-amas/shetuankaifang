# 用 Cloudflare Worker 跑后端（免费、不用信用卡）

GitHub Pages 只能放静态文件，登录和额度必须有个后端。这个目录就是后端：一个 Worker + 一个 KV 命名空间。

**全程在网页上点，不用装任何工具，大约 10 分钟。**

---

## 第 1 步：注册并建 Worker

1. 打开 <https://dash.cloudflare.com/sign-up>，用**邮箱**注册（不需要信用卡，也不用绑卡）
2. 登录后，左侧菜单点 **Workers & Pages**
3. 点 **Create**（或右上角 **Create application**）→ 选 **Workers** 标签 → **Create Worker**
4. 名字填 `shetuankaifang-api` → **Deploy**（先用模板部署一个空的）

> 第一次用 Workers 会让你设置一个 `workers.dev` 子域名，随便填（比如你的拼音），最终地址形如
> `https://shetuankaifang-api.你的子域.workers.dev`

## 第 2 步：粘贴代码

1. 部署成功后点 **Edit code**（或 “</>” 图标）
2. 左边编辑器里全选删掉默认代码
3. 把本仓库 `worker/worker.js` 的全部内容粘进去
4. 右上角 **Deploy**（这一步会保存并生效）

## 第 3 步：加环境变量

Worker 页面 → **Settings**（设置）→ **Variables and Secrets**（变量和机密）→ **Add**：

| 变量名 | 类型 | 值 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Secret | 你的 `sk-...` |
| `ACCOUNTS` | Text | `测试:123456:5000000`（多个账号用英文逗号隔开） |
| `ADMIN_PASSWORD` | Secret | 你自己定的管理员口令 |
| `SESSION_SECRET` | Secret | 随便一长串随机字符，比如 `x7Kp2LmQ9vRt4Bz8` |

可选：

| 变量名 | 说明 |
| --- | --- |
| `ALLOWED_ORIGINS` | 跨域白名单，默认已含 `https://zhanghang-amas.github.io` |
| `DEFAULT_QUOTA` | 不写额度时的默认值（默认 5000000） |
| `DEEPSEEK_BASE_URL` | 用中转站时填 |
| `SYSTEM_PROMPT` | 默认系统提示词 |

加完点 **Save / Deploy** 让它生效。

## 第 4 步：建 KV 存用量

没有 KV 也能跑（存在内存里，重启就丢），但要真正记住每个人的额度，得建一个：

1. Cloudflare 左侧菜单 → **Storage & Databases** → **KV** → **Create a namespace**
2. 名字填 `shetuankaifang` → **Add**
3. 回到 Worker → **Settings** → **Bindings**（绑定）→ **Add** → **KV Namespace**
4. Variable name 填 **`USERS`**（必须一模一样，大写）→ 选中刚才的 `shetuankaifang` → **Save**

## 第 5 步：验证

浏览器打开：

```
https://shetuankaifang-api.你的子域.workers.dev/api/health
```

应该返回：

```json
{"ok":true,"mode":"server","service":"shetuankaifang","storage":"kv"}
```

- 看到 `"storage":"kv"` 说明 KV 绑定成功
- 看到 `"storage":"memory"` 说明第 4 步没生效，回去检查绑定名是不是 `USERS`

然后把这个地址发给我（或者自己填进仓库根目录的 `config.js`）：

```js
window.DS_API_BASE = 'https://shetuankaifang-api.你的子域.workers.dev';
```

推上去后，打开 <https://zhanghang-amas.github.io/shetuankaifang/> 就会先看到登录页。

---

## 账号格式

`用户名:密码:额度`，多个用英文逗号隔开，额度不写就是默认 500 万：

```
测试:123456:5000000,张三:zhangsan2026:5000000,李四:lisi2026
```

- 账号**只在第一次启动时创建**，之后改 `ACCOUNTS` 不会覆盖已有账号（避免把用量冲掉）
- 想重置某人额度、改上限，用下面的管理员接口

## 管理员接口

请求头带 `X-Admin-Password`，值就是环境变量 `ADMIN_PASSWORD`。

```powershell
$base = 'https://shetuankaifang-api.你的子域.workers.dev'
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
| Worker 请求 | 10 万次/天 | 一次对话 2 个请求，一条消息 ≈ 2 次，绰绰有余 |
| Worker CPU | 每次 10ms | 只有登录做密码哈希，其余都是转发；密码哈希已压到 2000 次迭代 |
| KV 读 | 10 万次/天 | 每次请求读 1 次 |
| KV 写 | 1000 次/天 | 每轮对话写 1 次；如果社团一天聊超过 1000 轮再考虑升级 |

## 注意事项

- **密码哈希是 PBKDF2 2000 次**（受免费版 10ms CPU 限制），够用但不适合高安全场景；密码别用 123456 这种，最好 8 位以上。
- **workers.dev 在国内偶尔打不开**。如果打不开，告诉我，可以换成 Deno Deploy，或者给它绑一个自己的域名。
- KV 里存的是账号哈希和已用额度，不存 DeepSeek Key（Key 只在环境变量里）。

## 为什么不是 Render

Render 现在对部分新账号要求绑卡才能部署（哪怕是免费实例）。Cloudflare Workers 免费计划不需要任何支付方式，所以改成这个方案；代价是后端要按 Workers 的运行时重写一遍（本目录的 `worker.js`）。

`server/` 里的 Node 版本仍然保留，有服务器或愿意绑卡的话照样能用。
