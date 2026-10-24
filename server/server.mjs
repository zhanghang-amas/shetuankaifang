/**
 * 社团版 DeepSeek 网页助手 —— 零依赖 Node 服务
 *
 * 在原来「本地转发」的基础上加了一层真正的后端：
 *   1. 账号登录（用户名 + 密码，scrypt 加盐哈希）
 *   2. 每个账号独立的 token 额度（默认 500 万），按上游 usage 精确记账
 *   3. DeepSeek API Key 只存在服务器，浏览器永远拿不到
 *   4. 允许 GitHub Pages 跨域调用（用 Bearer token，不依赖第三方 Cookie）
 *
 * 启动：node server.mjs
 * 环境变量见 server/DEPLOY.md
 */

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, appendFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 静态文件放在仓库根目录，Node 服务与 GitHub Pages 共用同一套前端
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..');
// 只允许托管这几个文件，避免把 server.mjs / .git / data 暴露出去
const PUBLIC_FILES = new Set([
  'index.html',
  'app.js',
  'style.css',
  'favicon.svg',
  'runtime.js',
  'config.js',
  'auth.css',
]);

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
// 每个账号的对话记录，直接存在本机磁盘，浏览器清了也能恢复
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const ACCESS_LOG = path.join(DATA_DIR, 'access.log');
const PID_PATH = path.join(DATA_DIR, 'server.pid');

const FALLBACK_MODELS = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
];

const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 3000;

/* ---------------------------- 账号与额度 ---------------------------- */

// 默认给每个账号 500 万 tokens
const DEFAULT_QUOTA = Number(process.env.DEFAULT_QUOTA) || 5_000_000;
// 账号列表：环境变量优先，"用户名:密码:额度,用户名:密码" 的形式
const ACCOUNTS_ENV = process.env.ACCOUNTS || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 登录状态保留 30 天
// 管理员口令：设置后才能用 /api/admin/* 查用量、重置额度、改上限
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// 免费实例重启会丢磁盘，可选接一个 Upstash Redis 让用量不丢
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_STATE_KEY = process.env.STATE_KEY || 'shetuankaifang:users';

/* ---------------------------- 跨域 ---------------------------- */

const ALLOWED_ORIGINS = String(
  process.env.ALLOWED_ORIGINS ||
    'https://zhanghang-amas.github.io,http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:8123',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

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

/** 返回给前端的安全视图：不含明文 key */
function publicConfig(cfg) {
  return {
    hasKey: Boolean(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    temperature: cfg.temperature,
  };
}

/* ------------------------------------------------------------------ */
/* 账号存储（内存 + 本地文件 + 可选 Upstash）                             */
/* ------------------------------------------------------------------ */

let usersCache = null;

async function remoteGetState() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${REMOTE_STATE_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function remoteSetState(store) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/set/${REMOTE_STATE_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    });
  } catch {
    /* 远端写失败不影响本次对话 */
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(account, password) {
  try {
    const candidate = crypto.scryptSync(String(password), account.salt, 32);
    const expected = Buffer.from(account.hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function createUser(name, password, quota) {
  const { salt, hash } = hashPassword(password);
  return {
    name,
    salt,
    hash,
    quota: Number(quota) > 0 ? Number(quota) : DEFAULT_QUOTA,
    used: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 解析 ACCOUNTS 环境变量： "测试:123456:5000000,张三:密码" */
function parseAccountsEnv() {
  const out = [];
  for (const raw of String(ACCOUNTS_ENV).split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split(':');
    const name = (parts[0] || '').trim();
    const password = (parts[1] || '').trim();
    const quota = parts[2] ? Number(parts[2]) : DEFAULT_QUOTA;
    if (name && password) out.push({ name, password, quota });
  }
  return out;
}

async function saveUsers(store) {
  usersCache = store;
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${USERS_PATH}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await rename(tmp, USERS_PATH);
  } catch {
    /* 无写权限时退回内存模式，不影响本次运行 */
  }
  await remoteSetState(store);
}

async function loadUsers() {
  if (usersCache) return usersCache;

  let store = null;
  const remote = await remoteGetState();
  if (remote && remote.users) store = remote;

  if (!store) {
    try {
      const raw = await readFile(USERS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.users) store = parsed;
    } catch {
      /* 首次启动 */
    }
  }

  if (!store) store = { version: 1, users: {} };
  usersCache = store;

  // 环境变量里的账号：不存在就创建（已存在则不动，避免覆盖线上用量）
  const seeded = parseAccountsEnv();
  const accounts = seeded.length ? seeded : [{ name: '测试', password: '123456', quota: DEFAULT_QUOTA }];
  let changed = false;
  for (const account of accounts) {
    if (!store.users[account.name]) {
      store.users[account.name] = createUser(account.name, account.password, account.quota);
      changed = true;
    }
  }
  if (changed) await saveUsers(store);
  return store;
}

function userView(account) {
  const used = Math.max(0, Math.round(account.used || 0));
  const quota = Math.round(account.quota || 0);
  return {
    name: account.name,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    percent: quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 100,
  };
}

/* ------------------------------------------------------------------ */
/* 对话记录（存本机磁盘，按账号分开）                                     */
/* ------------------------------------------------------------------ */

function historyPath(name) {
  return path.join(HISTORY_DIR, `${encodeURIComponent(String(name))}.json`);
}

async function readHistory(name) {
  try {
    const raw = await readFile(historyPath(name), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(name, sessions) {
  await mkdir(HISTORY_DIR, { recursive: true });
  const target = historyPath(name);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(sessions), 'utf8');
  await rename(tmp, target);
}

async function addUsage(name, tokens) {
  if (!tokens) return;
  const store = await loadUsers();
  const account = store.users[name];
  if (!account) return;
  account.used = Math.max(0, Number(account.used || 0) + tokens);
  account.updatedAt = new Date().toISOString();
  await saveUsers(store);
}

/* ------------------------------------------------------------------ */
/* 会话令牌（HMAC 签名；SESSION_SECRET 固定时重启不掉登录）                */
/* ------------------------------------------------------------------ */

function sameSecret(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.u || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireUser(req, res) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = verifyToken(token);
  if (!payload) {
    sendJson(res, 401, { error: '登录状态已失效，请重新登录', code: 'UNAUTHORIZED' });
    return null;
  }
  const store = await loadUsers();
  const account = store.users[payload.u];
  if (!account) {
    sendJson(res, 401, { error: '账号不存在，请重新登录', code: 'UNAUTHORIZED' });
    return null;
  }
  return { name: payload.u, account };
}

/* 登录失败限流：同一 IP 10 分钟内最多 10 次 */
const loginFails = new Map();

function loginBlocked(ip) {
  const record = loginFails.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetAt) {
    loginFails.delete(ip);
    return false;
  }
  return record.count >= 10;
}

function noteLoginFail(ip) {
  const record = loginFails.get(ip) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  record.count += 1;
  loginFails.set(ip, record);
}

/* ------------------------------------------------------------------ */
/* 登录 / 账号信息                                                       */
/* ------------------------------------------------------------------ */

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (loginBlocked(ip)) {
    sendJson(res, 429, { error: '密码错误次数过多，请 10 分钟后再试' });
    return;
  }

  let input;
  try {
    input = JSON.parse(await readBody(req, 64 * 1024));
  } catch {
    sendJson(res, 400, { error: '请求格式错误' });
    return;
  }

  const name = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!name || !password) {
    sendJson(res, 400, { error: '请输入用户名和密码' });
    return;
  }

  const store = await loadUsers();
  const account = store.users[name];
  if (!account || !verifyPassword(account, password)) {
    noteLoginFail(ip);
    sendJson(res, 401, { error: '用户名或密码不正确' });
    return;
  }

  loginFails.delete(ip);
  const token = signToken({ u: name, exp: Date.now() + SESSION_TTL });
  sendJson(res, 200, { ok: true, token, user: userView(account) });
}

/* ------------------------------------------------------------------ */
/* 模型列表 / 连接测试                                                    */
/* ------------------------------------------------------------------ */

async function fetchModels(cfg) {
  const upstream = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, models: FALLBACK_MODELS };
  }
  const data = await upstream.json();
  const models = (Array.isArray(data.data) ? data.data : [])
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: m.name || m.id }));
  return { ok: true, status: upstream.status, models: models.length ? models : FALLBACK_MODELS };
}

async function handleModels(res) {
  const cfg = await readConfig();
  if (!cfg.apiKey) {
    sendJson(res, 200, { models: FALLBACK_MODELS, source: 'fallback', message: '服务器还没有配置 Key' });
    return;
  }
  try {
    const result = await fetchModels(cfg);
    if (result.ok) {
      sendJson(res, 200, { models: result.models, source: 'upstream' });
    } else {
      sendJson(res, 200, { models: FALLBACK_MODELS, source: 'fallback', message: `上游 HTTP ${result.status}` });
    }
  } catch (err) {
    sendJson(res, 200, { models: FALLBACK_MODELS, source: 'fallback', message: err.message });
  }
}

async function handleTest(res) {
  const cfg = await readConfig();
  if (!cfg.apiKey) {
    sendJson(res, 200, { ok: false, message: '服务器还没有配置 Key' });
    return;
  }
  const started = Date.now();
  try {
    const result = await fetchModels(cfg);
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        message: `连接正常：HTTP ${result.status}，${result.models.length} 个模型，${Date.now() - started}ms`,
      });
    } else {
      sendJson(res, 200, { ok: false, message: `上游返回 HTTP ${result.status}` });
    }
  } catch (err) {
    sendJson(res, 200, { ok: false, message: `连接失败：${err.message}` });
  }
}

/* ------------------------------------------------------------------ */
/* 对话：转发 SSE，并按 usage 记账                                        */
/* ------------------------------------------------------------------ */

const estimateTokens = (chars) => Math.ceil(Number(chars || 0) / 1.6);

async function handleChat(req, res, ctx) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `请求格式错误：${err.message}` });
    return;
  }

  const cfg = await readConfig();
  if (!cfg.apiKey) {
    sendJson(res, 400, { error: '服务器还没有配置 DeepSeek API Key，请联系管理员。' });
    return;
  }

  if (ctx.account.quota - ctx.account.used <= 0) {
    sendJson(res, 403, {
      error: `账号「${ctx.name}」的额度已经用完了（上限 ${fmt(ctx.account.quota)} tokens），请联系管理员。`,
      code: 'QUOTA_EXCEEDED',
      user: userView(ctx.account),
    });
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

  // 允许用户带自己的系统提示词，没带就用服务器默认的
  const customPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt.trim().slice(0, 8000) : '';
  const systemPrompt = customPrompt || (typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt.trim() : '');
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });

  const requested = typeof payload.model === 'string' ? payload.model.trim() : '';
  const model = requested || cfg.model;

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (!/reason/i.test(model)) body.temperature = cfg.temperature;

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
    if (upstream.status === 401) message = 'API Key 无效或已过期，请联系管理员。';
    if (upstream.status === 402) message = 'DeepSeek 账户余额不足，请联系管理员充值。';
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

  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  let usage = null;
  let outChars = 0;
  let buffer = '';
  const decoder = new TextDecoder();

  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);

      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          if (json.usage) usage = json.usage;
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && typeof delta.content === 'string') outChars += delta.content.length;
          if (delta && typeof delta.reasoning_content === 'string') outChars += delta.reasoning_content.length;
        } catch {
          /* 半行 / 非 JSON 忽略 */
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const detail = JSON.stringify({ error: { message: `连接中断：${err.message}` } });
      if (!res.writableEnded) res.write(`data: ${detail}\n\n`);
    }
  } finally {
    if (!res.writableEnded) res.end();

    // 记账：优先用上游 usage，拿不到就按字符数估算
    let spent = 0;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
      spent = Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
    } else {
      spent = estimateTokens(promptChars) + estimateTokens(outChars);
    }
    await addUsage(ctx.name, spent).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  res.on('finish', () => {
    const line = `${new Date().toISOString()}\t${res.statusCode}\t${req.method}\t${pathname}\t${String(req.headers['user-agent'] || '').slice(0, 60)}\n`;
    appendFile(ACCESS_LOG, line).catch(() => {});
  });

  try {
    // 健康检查：公开，不需要登录（前端用它判断是静态托管还是服务端模式）
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, mode: 'server', service: 'shetuankaifang' });
      return;
    }

    // 管理员接口：查看用量 / 重置额度 / 调整上限
    if (pathname.startsWith('/api/admin/')) {
      if (!ADMIN_PASSWORD) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }
      if (!sameSecret(req.headers['x-admin-password'], ADMIN_PASSWORD)) {
        sendJson(res, 401, { error: '管理员口令不正确' });
        return;
      }

      const store = await loadUsers();

      if (pathname === '/api/admin/users' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          users: Object.values(store.users).map((account) => ({
            ...userView(account),
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          })),
        });
        return;
      }

      if (pathname === '/api/admin/reset' && req.method === 'POST') {
        let input = {};
        try {
          input = JSON.parse(await readBody(req, 64 * 1024));
        } catch {
          /* 允许空 body：重置全部 */
        }
        const target = String(input.username || '').trim();
        const names = target ? [target] : Object.keys(store.users);
        const done = [];
        for (const name of names) {
          if (!store.users[name]) continue;
          store.users[name].used = 0;
          store.users[name].updatedAt = new Date().toISOString();
          done.push(name);
        }
        await saveUsers(store);
        sendJson(res, 200, { ok: true, reset: done });
        return;
      }

      if (pathname === '/api/admin/quota' && req.method === 'POST') {
        let input;
        try {
          input = JSON.parse(await readBody(req, 64 * 1024));
        } catch {
          sendJson(res, 400, { error: '请求体不是合法的 JSON' });
          return;
        }
        const target = String(input.username || '').trim();
        const quota = Number(input.quota);
        if (!store.users[target]) {
          sendJson(res, 404, { error: '账号不存在' });
          return;
        }
        if (!Number.isFinite(quota) || quota <= 0) {
          sendJson(res, 400, { error: 'quota 必须是正数' });
          return;
        }
        store.users[target].quota = quota;
        store.users[target].updatedAt = new Date().toISOString();
        await saveUsers(store);
        sendJson(res, 200, { ok: true, user: userView(store.users[target]) });
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (pathname === '/api/login') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      await handleLogin(req, res);
      return;
    }

    // 以下接口都要登录
    if (pathname.startsWith('/api/')) {
      const ctx = await requireUser(req, res);
      if (!ctx) return;

      if (pathname === '/api/me') {
        sendJson(res, 200, { ok: true, user: userView(ctx.account) });
        return;
      }

      // 对话记录：GET 拉取，PUT 覆盖保存（整份列表，和前端 localStorage 同构）
      if (pathname === '/api/sessions') {
        if (req.method === 'GET') {
          const sessions = await readHistory(ctx.name);
          sendJson(res, 200, { ok: true, sessions, count: sessions.length });
          return;
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          let input;
          try {
            input = JSON.parse(await readBody(req, 32 * 1024 * 1024));
          } catch (err) {
            sendJson(res, 400, { error: `请求格式错误：${err.message}` });
            return;
          }
          const sessions = input && Array.isArray(input.sessions) ? input.sessions : null;
          if (!sessions) {
            sendJson(res, 400, { error: 'sessions 必须是数组' });
            return;
          }
          await writeHistory(ctx.name, sessions);
          sendJson(res, 200, { ok: true, count: sessions.length });
          return;
        }
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      if (pathname === '/api/config') {
        if (req.method === 'GET') {
          const cfg = await readConfig();
          sendJson(res, 200, { ...publicConfig(cfg), server: true, user: userView(ctx.account) });
          return;
        }
        sendJson(res, 403, { error: '本站的 Key 由服务器统一管理，无法在页面里修改' });
        return;
      }

      if (pathname === '/api/models') {
        await handleModels(res);
        return;
      }

      if (pathname === '/api/test') {
        await handleTest(res);
        return;
      }

      if (pathname === '/api/chat') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' });
          return;
        }
        await handleChat(req, res, ctx);
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
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

const store = await loadUsers();
console.log(`  账号: ${Object.keys(store.users).join('、')}`);
console.log(`  默认额度: ${fmt(DEFAULT_QUOTA)} tokens/账号`);

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
console.log('  社团版 DeepSeek 网页助手已启动');
console.log(`  地址: ${url}`);
console.log(`  PID : ${process.pid}`);
console.log(`  跨域白名单: ${ALLOWED_ORIGINS.join(', ')}`);
console.log('  停止: 按 Ctrl+C');
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
