# DeepSeek 网页助手 · 社团开荒

一个**零第三方依赖**的 DeepSeek 网页对话界面：流式输出、深度思考（Reasoner）、多套主题、多轮会话，全部只用原生 HTML/CSS/JS 写成。

线上地址：**https://zhanghang-amas.github.io/shetuankaifang/**

> 第一次打开会弹出「设置」，把你自己的 DeepSeek API Key 粘进去就能聊。Key 只保存在**你自己浏览器的 localStorage** 里，不会上传到任何地方，也不会进这个仓库。

---

## 这个仓库有什么

```
shetuankaifang/
├── index.html            页面骨架
├── style.css             主题变量与全部样式
├── app.js                前端逻辑（会话、流式渲染、轻量 Markdown）
├── static-adapter.js     双模式适配器：判断当前是「静态托管」还是「Node 服务」
├── favicon.svg           小鲸鱼图标
├── .nojekyll             让 GitHub Pages 不做 Jekyll 处理
├── README.md             本文件
└── server/               可选：想共享一个 Key + 访问密码时用
    ├── server.mjs        零依赖 Node 服务（SSE 转发、访问密码、健康检查）
    ├── package.json
    ├── Dockerfile
    └── DEPLOY.md         部署到 Render / Railway / VPS 的步骤
```

同一个前端有两种运行模式，`static-adapter.js` 会自动判断：

| 环境 | 判断依据 | Key 存在哪 | 请求路径 |
| --- | --- | --- | --- |
| GitHub Pages（静态托管） | `GET api/health` 拿不到 JSON | 访客自己的浏览器 | 浏览器 → `api.deepseek.com` 直连 |
| Node 服务（`server/server.mjs`） | `GET api/health` 返回 `{"ok":true}` | 服务器 `server/data/config.json` | 浏览器 → 本机服务 → DeepSeek |

---

## 一、直接在线用（GitHub Pages）

1. 打开 <https://zhanghang-amas.github.io/shetuankaifang/>
2. 右上角「设置」→ 粘贴 API Key →「保存」
3. 没有 Key 的话去 <https://platform.deepseek.com/api_keys> 创建一个（账户需要有余额）

每个人用的都是自己的 Key，互不影响：你的对话记录、Key、主题设置都只存在你自己的浏览器里，换设备就重新填一次。

---

## 二、在本机跑（Node，可选）

需要 Node.js 20 或以上。

```bash
node server/server.mjs --open
```

默认打开 <http://127.0.0.1:3000>。这时 Key 保存在 `server/data/config.json`，浏览器里不用填。

可用的环境变量：

| 变量 | 作用 |
| --- | --- |
| `PORT` | 起始端口（默认 3000，被占用会自动往后找 3000–3019） |
| `HOST` | 监听地址，局域网给手机用时设 `0.0.0.0` |
| `ACCESS_PASSWORD` | 访问密码，设置后页面和接口都要先登录 |
| `DEEPSEEK_API_KEY` | 初始 Key（也可以进页面再填） |
| `COOKIE_SECURE` | HTTPS 下设 `1`，登录 Cookie 只走加密连接 |

---

## 三、公网共享一个 Key（可选）

如果想让社团成员共用一个 Key、又不想让 Key 出现在任何人的浏览器里，就用 Node 版部署：仓库里的 `server/` 目录可以直接扔到 Render / Railway / Zeabur / VPS / Docker 上，配有访问密码和 `/api/health` 健康检查。

完整步骤见 [server/DEPLOY.md](server/DEPLOY.md)。

---

## 常见问题

**提示「API Key 无效或已过期」**
Key 复制不完整，或者账户没余额。到 <https://platform.deepseek.com/api_keys> 重新生成一个。

**提示「无法连接 DeepSeek」**
网络或代理问题。也可以到「设置」里把「API 地址」改成中转站地址（不要带 `/v1`，程序会自己拼 `/chat/completions`）。

**回答不是逐字出现的**
这版是浏览器直连，正常情况下是流式的；如果浏览器插件（广告拦截、脚本管理）拦截了流式响应，关掉插件再试。

**对话记录在哪**
在浏览器 localStorage 里。换浏览器、清缓存会丢，重要对话自己另存。

**改了样式不生效**
`index.html` 里 CSS/JS 带了 `?v=13` 版本号，改完记得同步加数字，或者 Ctrl+F5 强制刷新。

**想换默认模型**
「设置」里能填系统提示词；模型在下拉框里选 Chat / Reasoner，选择会记在本地。配置了 Key 后下拉框会自动拉取上游真实模型列表。

---

## 隐私与安全

- 静态模式下 Key 只存在你自己的浏览器，页面不会把它发给除 DeepSeek 官方接口（或你手填的中转地址）以外的任何服务器。
- `server/data/` 里是明文 Key，已被 `.gitignore` 排除，**不要提交**。
- 公开部署 Node 版时务必设置 `ACCESS_PASSWORD`，否则任何人都能消耗你的余额。
- 浏览器 localStorage 里的 Key 用 `F12 → Application` 可见，公用电脑上用完记得点「清除 Key」。

## 许可

MIT
