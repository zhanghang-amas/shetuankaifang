/**
 * 本地 DeepSeek 网页助手 —— 零依赖 Node 服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态页面
 *   2. 把浏览器里的对话以 SSE 流式转发给 DeepSeek
 *   3. 把 API Key 保存在本机 data/config.json，不暴露给前端
 *
 * 启动：node server.mjs [--open]
 */

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 静态文件放在仓库根目录，Node 服务与 GitHub Pages 共用同一套前端
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..');
// 只允许托管这几个文件，避免把 server.mjs / .git / data 暴露出去
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'favicon.svg', 'static-adapter.js']);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ACCESS_LOG = path.join(DATA_DIR, 'access.log');
const FALLBACK_MODELS = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
];

const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 3000;

// 部署到公网时务必设置 ACCESS_PASSWORD；不设置则保持本机免密访问
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const AUTH_COOKIE = 'ds_auth';
const AUTH_TOKEN = ACCESS_PASSWORD
  ? crypto.createHash('sha256').update(`deepseek-local::${ACCESS_PASSWORD}`).digest('hex')
  : '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';

const DEFAULT_CONFIG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  systemPrompt: '你是一个乐于助人的 AI 助手，请用简体中文回答，回答要准确、简洁。',
  temperature: 1.0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 配置读写                                                             */
/* ------------------------------------------------------------------ */

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 返回给前端的安全视图：不含明文 key */
function publicConfig(cfg) {
  return {
    hasKey: Boolean(cfg.apiKey),
    keyHint: cfg.apiKey ? `${cfg.apiKey.slice(0, 4)}••••${cfg.apiKey.slice(-4)}` : '',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    temperature: cfg.temperature,
  };
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeBaseUrl(input) {
  const value = String(input || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(value)) {
    throw new Error('Base URL 需要以 http:// 或 https:// 开头');
  }
  return value;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !PUBLIC_FILES.has(path.basename(filePath))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/* ------------------------------------------------------------------ */
/* 访问密码（部署到公网时使用）                                          */
/* ------------------------------------------------------------------ */

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req) {
  if (!ACCESS_PASSWORD) return true;
  return sameSecret(readCookie(req, AUTH_COOKIE), AUTH_TOKEN);
}

function loginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>访问验证 · DeepSeek 本地助手</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f8; color: #17171a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: min(360px, calc(100vw - 40px)); padding: 28px; border: 1px solid #e7e7eb; border-radius: 18px; background: #fff; box-shadow: 0 18px 50px rgba(15, 18, 25, 0.08); }
  .logo { width: 44px; height: 44px; margin-bottom: 18px; border-radius: 12px; background: #4d6bfe; display: grid; place-items: center; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  p { margin: 0 0 18px; color: #55575e; font-size: 13px; }
  input { width: 100%; padding: 11px 13px; border: 1px solid #d8d8de; border-radius: 10px; font-size: 15px; outline: none; }
  input:focus { border-color: #4d6bfe; box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.12); }
  button { width: 100%; margin-top: 12px; padding: 11px; border: 0; border-radius: 10px; background: #4d6bfe; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .err { min-height: 18px; margin-top: 10px; color: #d6455d; font-size: 13px; }
</style>
</head>
<body>
  <form class="card" id="f">
    <div class="logo">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <ellipse cx="14" cy="18.5" rx="10.5" ry="7.5" fill="#fff" />
        <path d="M23.5 18.5 30 12.8v11.4Z" fill="#fff" />
        <path d="M13 10.6c0-2.2 1.2-4 3.2-4.8M17 10.2c0-1.5.7-2.8 1.9-3.7" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
        <circle cx="9.8" cy="16.7" r="1.15" fill="#4d6bfe" />
      </svg>
    </div>
    <h1>访问验证</h1>
    <p>这个站点已开启访问密码，请输入后继续。</p>
    <input id="pw" type="password" placeholder="访问密码" autocomplete="current-password" autofocus />
    <button id="go" type="submit">进入</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    const form = document.getElementById('f');
    const pw = document.getElementById('pw');
    const go = document.getElementById('go');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      go.disabled = true;
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        if (res.ok) {
          let next = new URLSearchParams(location.search).get('next') || '/';
          if (!next.startsWith('/') || next.startsWith('//')) next = '/';
          location.replace(next);
          return;
        }
        const data = await res.json().catch(() => ({}));
        err.textContent = data.error || '密码不正确';
      } catch {
        err.textContent = '网络错误，请重试';
      }
      go.disabled = false;
    });
  </script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* 对话：把上游 SSE 原样转发给浏览器，并处理错误与中断                     */
/* ------------------------------------------------------------------ */

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `请求格式错误：${err.message}` });
    return;
  }

  const cfg = await readConfig();
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: '还没有配置 API Key。点击右上角「设置」填入 DeepSeek 的 API Key。' });
    return;
  }

  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 100_000) }));

  if (!messages.length) {
    sendJson(res, 400, { error: '没有可发送的消息' });
    return;
  }

  const systemPrompt = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt.trim() : '';
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });

  // 模型名透传：上游有哪些模型由 /api/models 动态获取，这里不再写死白名单
  const requested = typeof payload.model === 'string' ? payload.model.trim() : '';
  const model = requested || cfg.model;

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (!/reason/i.test(model)) {
    body.temperature = cfg.temperature;
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let endpoint;
  try {
    endpoint = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`;
  } catch (err) {
    sendJson(res, 400, { error: `API 地址无效：${err.message}` });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    sendJson(res, 502, { error: `无法连接 DeepSeek：${err.message}` });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    let message = `DeepSeek 返回 ${upstream.status}`;
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      if (raw) message = raw.slice(0, 300);
    }
    if (upstream.status === 401) message = 'API Key 无效或已过期，请到「设置」里检查。';
    if (upstream.status === 402) message = 'DeepSeek 账户余额不足，请先充值。';
    if (upstream.status === 429) message = '请求太频繁或额度耗尽，请稍后再试。';
    sendJson(res, 502, { error: message });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      // 头已发出，只能在流里塞一个错误事件
      const detail = JSON.stringify({ error: { message: `连接中断：${err.message}` } });
      if (!res.writableEnded) res.write(`data: ${detail}\n\n`);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  res.on('finish', () => {
    const line = `${new Date().toISOString()}\t${res.statusCode}\t${req.method}\t${pathname}\t${String(req.headers['user-agent'] || '').slice(0, 60)}\n`;
    appendFile(ACCESS_LOG, line).catch(() => {});
  });

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 设置了 ACCESS_PASSWORD 时，页面与接口都需要先通过密码验证
    if (ACCESS_PASSWORD) {
      if (pathname === '/login' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(loginPage());
        return;
      }

      if (pathname === '/api/login') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' });
          return;
        }
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: '请求格式错误' });
          return;
        }
        if (!sameSecret(input && input.password, ACCESS_PASSWORD)) {
          sendJson(res, 401, { error: '访问密码不正确' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${AUTH_COOKIE}=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${COOKIE_SECURE}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (!isAuthed(req)) {
        if (pathname.startsWith('/api/')) {
          sendJson(res, 401, { error: '需要登录后访问' });
          return;
        }
        const next = encodeURIComponent(pathname + (url.search || ''));
        res.writeHead(302, { Location: `/login?next=${next}` });
        res.end();
        return;
      }
    }

    if (pathname === '/api/config') {
      if (req.method === 'GET') {
        const cfg = await readConfig();
        sendJson(res, 200, publicConfig(cfg));
        return;
      }
      if (req.method === 'POST') {
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: '请求体不是合法的 JSON' });
          return;
        }
        const patch = {};

        if (typeof input.apiKey === 'string') {
          patch.apiKey = input.apiKey === '__CLEAR__' ? '' : input.apiKey.trim();
        }
        if (typeof input.baseUrl === 'string') {
          try {
            patch.baseUrl = normalizeBaseUrl(input.baseUrl);
          } catch (err) {
            sendJson(res, 400, { error: err.message });
            return;
          }
        }
        if (typeof input.systemPrompt === 'string') patch.systemPrompt = input.systemPrompt.slice(0, 8000);
        if (typeof input.model === 'string') patch.model = input.model;
        if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
          patch.temperature = Math.min(2, Math.max(0, input.temperature));
        }

        const next = await writeConfig(patch);
        sendJson(res, 200, { ok: true, config: publicConfig(next) });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    if (pathname === '/api/models') {
      const cfg = await readConfig();
      if (!cfg.apiKey) {
        sendJson(res, 200, { models: FALLBACK_MODELS, source: 'fallback', message: '还没有配置 Key' });
        return;
      }
      try {
        const upstream = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!upstream.ok) {
          sendJson(res, 200, {
            models: FALLBACK_MODELS,
            source: 'fallback',
            message: `上游 HTTP ${upstream.status}`,
          });
          return;
        }
        const data = await upstream.json();
        const models = (Array.isArray(data.data) ? data.data : [])
          .filter((m) => m && typeof m.id === 'string')
          .map((m) => ({ id: m.id, name: m.name || m.id }));
        sendJson(res, 200, {
          models: models.length ? models : FALLBACK_MODELS,
          source: models.length ? 'upstream' : 'fallback',
        });
      } catch (err) {
        sendJson(res, 200, { models: FALLBACK_MODELS, source: 'fallback', message: err.message });
      }
      return;
    }

    if (pathname === '/api/test') {
      const cfg = await readConfig();
      if (!cfg.apiKey) {
        sendJson(res, 200, { ok: false, message: '还没有保存 API Key' });
        return;
      }
      const started = Date.now();
      try {
        const upstream = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        const raw = await upstream.text();
        if (upstream.ok) {
          let count = 0;
          try {
            count = (JSON.parse(raw).data || []).length;
          } catch {
            /* 忽略解析失败 */
          }
          sendJson(res, 200, {
            ok: true,
            message: `连接正常：HTTP ${upstream.status}，${count} 个模型，${Date.now() - started}ms`,
          });
        } else {
          let detail = raw.slice(0, 200);
          try {
            detail = JSON.parse(raw).error?.message || detail;
          } catch {
            /* 保留原始文本 */
          }
          sendJson(res, 200, { ok: false, message: `上游返回 HTTP ${upstream.status}：${detail}` });
        }
      } catch (err) {
        sendJson(res, 200, { ok: false, message: `连接失败：${err.message}` });
      }
      return;
    }

    if (pathname === '/api/chat') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      await handleChat(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就让用户手动访问 */
  }
}

const PID_PATH = path.join(DATA_DIR, 'server.pid');

let port = BASE_PORT;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    port = await listen(BASE_PORT + attempt);
    break;
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;

    // 已经有一个实例在跑：不再开第二个，直接打开浏览器
    if (attempt === 0) {
      const alive = await fetch(`http://${HOST}:${BASE_PORT}/api/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (alive) {
        console.log(`  服务已经在运行：http://${HOST}:${BASE_PORT}`);
        console.log('  已为你打开浏览器，无需重复启动。');
        openBrowser(`http://${HOST}:${BASE_PORT}`);
        process.exit(0);
      }
    }

    if (attempt === 19) throw new Error('3000-3019 端口都被占用，请设置环境变量 PORT');
  }
}

await mkdir(DATA_DIR, { recursive: true });
await writeFile(PID_PATH, String(process.pid), 'utf8');

const url = `http://${HOST}:${port}`;
console.log('');
console.log('  DeepSeek 本地助手已启动');
console.log(`  地址: ${url}`);
console.log(`  PID : ${process.pid}`);
console.log(`  访问密码: ${ACCESS_PASSWORD ? '已开启' : '未设置（仅建议本机使用）'}`);
console.log('  停止: 双击 stop.bat，或按 Ctrl+C');
console.log('');

async function cleanupAndExit() {
  try {
    await unlink(PID_PATH);
  } catch {
    /* 文件不存在就算了 */
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

if (process.argv.includes('--open')) openBrowser(url);
