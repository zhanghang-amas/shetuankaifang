/**
 * 社团 DeepSeek 助手 · Cloudflare Worker 后端
 *
 * 和 server/server.mjs 功能一致，只是换成 Workers 运行时：
 *   1. 账号登录（PBKDF2-SHA256 加盐哈希）
 *   2. 每个账号 500 万 token 额度，按 DeepSeek 返回的 usage 记账
 *   3. DeepSeek Key 只存在 Worker 的环境变量里
 *   4. 把 SSE 原样透传给浏览器（GitHub Pages 上的前端）
 *
 * 需要的绑定：
 *   环境变量  DEEPSEEK_API_KEY / ACCOUNTS / ADMIN_PASSWORD / SESSION_SECRET
 *   KV 命名空间 变量名 USERS（没有也能跑，但重启会丢用量，只适合试用）
 *
 * 部署步骤见同目录 README.md
 */

const DEFAULT_QUOTA = 5_000_000;
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_SYSTEM_PROMPT = '你是一个乐于助人的 AI 助手，请用简体中文回答，回答要准确、简洁。';
const PBKDF2_ITERATIONS = 2000; // Workers 免费版每次请求 CPU 上限 10ms，迭代次数不能高
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_BODY = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function bytesToB64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToB64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  const left = typeof a === 'string' ? encoder.encode(a) : a;
  const right = typeof b === 'string' ? encoder.encode(b) : b;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* 密码 / 令牌                                                          */
/* ------------------------------------------------------------------ */

async function derivePassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

function randomSalt() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

function secretOf(env) {
  return env.SESSION_SECRET || 'shetuankaifang-insecure-default-secret';
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(env, payload) {
  const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(body));
  return `${body}.${bytesToB64url(new Uint8Array(signature))}`;
}

async function verifyToken(env, token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(body));
  if (!timingSafeEqual(b64ToBytes(signature), new Uint8Array(expected))) return null;
  try {
    const payload = JSON.parse(decoder.decode(b64ToBytes(body)));
    if (!payload || !payload.u || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 存储（KV；没绑定就用内存，重启即丢）                                   */
/* ------------------------------------------------------------------ */

const memoryState = { value: null };

const STATE_KEY = 'state';

async function loadState(env) {
  if (!env.USERS) {
    if (!memoryState.value) memoryState.value = { version: 1, users: {} };
    return memoryState.value;
  }
  try {
    const raw = await env.USERS.get(STATE_KEY);
    if (!raw) return { version: 1, users: {} };
    const parsed = JSON.parse(raw);
    if (parsed && parsed.users) return parsed;
    return { version: 1, users: {} };
  } catch {
    return { version: 1, users: {} };
  }
}

async function saveState(env, state, ctx) {
  if (!env.USERS) {
    memoryState.value = state;
    return;
  }
  const task = env.USERS.put(STATE_KEY, JSON.stringify(state));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

function parseAccountsEnv(env) {
  const raw = String(env.ACCOUNTS || '').trim();
  const list = [];
  for (const item of raw.split(',')) {
    const text = item.trim();
    if (!text) continue;
    const parts = text.split(':');
    const name = (parts[0] || '').trim();
    const password = (parts[1] || '').trim();
    const quota = parts[2] ? Number(parts[2]) : DEFAULT_QUOTA;
    if (name && password) list.push({ name, password, quota: Number(quota) > 0 ? Number(quota) : DEFAULT_QUOTA });
  }
  return list;
}

async function ensureUsers(env, ctx) {
  const state = await loadState(env);
  const accounts = parseAccountsEnv(env);
  const wanted = accounts.length ? accounts : [{ name: '测试', password: '123456', quota: DEFAULT_QUOTA }];

  let changed = false;
  for (const account of wanted) {
    if (state.users[account.name]) continue;
    const salt = randomSalt();
    state.users[account.name] = {
      name: account.name,
      salt,
      hash: await derivePassword(account.password, salt),
      quota: account.quota,
      used: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }
  if (changed) await saveState(env, state, ctx);
  return state;
}

/* 对话记录：KV 里按账号存一份 JSON */
const memoryHistory = {};

function historyKey(name) {
  return `history:${name}`;
}

async function readHistory(env, name) {
  if (!env.USERS) return memoryHistory[name] || [];
  try {
    const raw = await env.USERS.get(historyKey(name));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(env, name, sessions) {
  if (!env.USERS) {
    memoryHistory[name] = sessions;
    return;
  }
  await env.USERS.put(historyKey(name), JSON.stringify(sessions));
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
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 跨域                                                                 */
/* ------------------------------------------------------------------ */

function allowedOrigins(env) {
  return String(
    env.ALLOWED_ORIGINS ||
      'https://zhanghang-amas.github.io,http://127.0.0.1:3000,http://127.0.0.1:8123,http://localhost:3000',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  if (!allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/* ------------------------------------------------------------------ */
/* 对话                                                                 */
/* ------------------------------------------------------------------ */

const estimateTokens = (chars) => Math.ceil(Number(chars || 0) / 1.6);

async function handleChat(request, env, ctx, account, cors) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: `请求格式错误：${err.message}` }, 400, cors);
  }

  const apiKey = env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    return json({ error: '服务器还没有配置 DeepSeek API Key，请联系管理员。' }, 400, cors);
  }

  if (account.quota - account.used <= 0) {
    return json(
      {
        error: `账号「${account.name}」的额度已经用完了（上限 ${fmt(account.quota)} tokens），请联系管理员。`,
        code: 'QUOTA_EXCEEDED',
        user: userView(account),
      },
      403,
      cors,
    );
  }

  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 100000) }));

  if (!messages.length) return json({ error: '没有可发送的消息' }, 400, cors);

  const customPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt.trim().slice(0, 8000) : '';
  const systemPrompt = customPrompt || env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });

  const requested = typeof payload.model === 'string' ? payload.model.trim() : '';
  const model = requested || env.DEFAULT_MODEL || 'deepseek-chat';

  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (!/reason/i.test(model)) body.temperature = Number(env.TEMPERATURE || 1);

  const baseUrl = String(env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return json({ error: `无法连接 DeepSeek：${err.message}` }, 502, cors);
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    let message = `DeepSeek 返回 ${upstream.status}`;
    try {
      const parsed = JSON.parse(raw);
      message = (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || message;
    } catch {
      if (raw) message = raw.slice(0, 300);
    }
    if (upstream.status === 401) message = 'API Key 无效或已过期，请联系管理员。';
    if (upstream.status === 402) message = 'DeepSeek 账户余额不足，请联系管理员充值。';
    if (upstream.status === 429) message = '请求太频繁或额度耗尽，请稍后再试。';
    return json({ error: message }, 502, cors);
  }

  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  let usage = null;
  let outChars = 0;
  let buffer = '';
  const name = account.name;

  const monitor = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
          const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (delta && typeof delta.content === 'string') outChars += delta.content.length;
          if (delta && typeof delta.reasoning_content === 'string') outChars += delta.reasoning_content.length;
        } catch {
          /* 半行忽略 */
        }
      }
    },
    async flush() {
      let spent = 0;
      if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
        spent = Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
      } else {
        spent = estimateTokens(promptChars) + estimateTokens(outChars);
      }
      if (!spent) return;
      const state = await loadState(env);
      const target = state.users[name];
      if (!target) return;
      target.used = Math.max(0, Number(target.used || 0) + spent);
      target.updatedAt = new Date().toISOString();
      await saveState(env, state);
    },
  });

  const headers = {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  };

  return new Response(upstream.body.pipeThrough(monitor), { status: 200, headers });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

async function handleLogin(request, env, ctx, cors) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400, cors);
  }

  const name = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!name || !password) return json({ error: '请输入用户名和密码' }, 400, cors);

  const state = await ensureUsers(env, ctx);
  const account = state.users[name];
  if (!account) return json({ error: '用户名或密码不正确' }, 401, cors);

  const hash = await derivePassword(password, account.salt);
  if (!timingSafeEqual(hash, account.hash)) {
    return json({ error: '用户名或密码不正确' }, 401, cors);
  }

  const token = await signToken(env, { u: name, exp: Date.now() + SESSION_TTL });
  return json({ ok: true, token, user: userView(account) }, 200, cors);
}

/** 自己改密码 */
async function handlePasswordChange(request, env, ctx, account, cors) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400, cors);
  }

  const oldPassword = String(input.oldPassword || '');
  const newPassword = String(input.newPassword || '');
  if (newPassword.length < 6) return json({ error: '新密码至少 6 位' }, 400, cors);
  if (newPassword === oldPassword) return json({ error: '新密码不能和原密码一样' }, 400, cors);

  const currentHash = await derivePassword(oldPassword, account.salt);
  if (!timingSafeEqual(currentHash, account.hash)) {
    return json({ error: '原密码不正确' }, 401, cors);
  }

  const state = await loadState(env);
  const target = state.users[account.name];
  if (!target) return json({ error: '账号不存在' }, 401, cors);

  const salt = randomSalt();
  target.salt = salt;
  target.hash = await derivePassword(newPassword, salt);
  target.updatedAt = new Date().toISOString();
  await saveState(env, state, ctx);
  return json({ ok: true, message: '密码已修改' }, 200, cors);
}

async function handleModels(env, cors) {
  const apiKey = env.DEEPSEEK_API_KEY || '';
  const fallback = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ];
  if (!apiKey) return json({ models: fallback, source: 'fallback', message: '服务器还没有配置 Key' }, 200, cors);

  const baseUrl = String(env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return json({ models: fallback, source: 'fallback', message: `上游 HTTP ${res.status}` }, 200, cors);
    const data = await res.json();
    const models = (Array.isArray(data.data) ? data.data : [])
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: m.id, name: m.name || m.id }));
    return json({ models: models.length ? models : fallback, source: 'upstream' }, 200, cors);
  } catch (err) {
    return json({ models: fallback, source: 'fallback', message: err.message }, 200, cors);
  }
}

async function handleTest(env, cors) {
  const apiKey = env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return json({ ok: false, message: '服务器还没有配置 Key' }, 200, cors);
  const baseUrl = String(env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      const data = await res.json().catch(() => ({ data: [] }));
      const count = Array.isArray(data.data) ? data.data.length : 0;
      return json({ ok: true, message: `连接正常：HTTP ${res.status}，${count} 个模型，${Date.now() - started}ms` }, 200, cors);
    }
    return json({ ok: false, message: `上游返回 HTTP ${res.status}` }, 200, cors);
  } catch (err) {
    return json({ ok: false, message: `连接失败：${err.message}` }, 200, cors);
  }
}

async function handleAdmin(request, env, ctx, pathname, cors) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'Not Found' }, 404, cors);
  if (!timingSafeEqual(String(request.headers.get('X-Admin-Password') || ''), env.ADMIN_PASSWORD)) {
    return json({ error: '管理员口令不正确' }, 401, cors);
  }

  const state = await loadState(env);

  if (pathname === '/api/admin/users') {
    return json({ ok: true, users: Object.values(state.users).map(userView) }, 200, cors);
  }

  if (pathname === '/api/admin/reset') {
    let input = {};
    try {
      input = await request.json();
    } catch {
      /* 空 body = 重置全部 */
    }
    const target = String((input && input.username) || '').trim();
    const names = target ? [target] : Object.keys(state.users);
    const done = [];
    for (const name of names) {
      if (!state.users[name]) continue;
      state.users[name].used = 0;
      state.users[name].updatedAt = new Date().toISOString();
      done.push(name);
    }
    await saveState(env, state, ctx);
    return json({ ok: true, reset: done }, 200, cors);
  }

  if (pathname === '/api/admin/quota') {
    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: '请求体不是合法的 JSON' }, 400, cors);
    }
    const target = String(input.username || '').trim();
    const quota = Number(input.quota);
    if (!state.users[target]) return json({ error: '账号不存在' }, 404, cors);
    if (!Number.isFinite(quota) || quota <= 0) return json({ error: 'quota 必须是正数' }, 400, cors);
    state.users[target].quota = quota;
    state.users[target].updatedAt = new Date().toISOString();
    await saveState(env, state, ctx);
    return json({ ok: true, user: userView(state.users[target]) }, 200, cors);
  }

  if (pathname === '/api/admin/password' && request.method === 'POST') {
    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: '请求体不是合法的 JSON' }, 400, cors);
    }
    const target = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!state.users[target]) return json({ error: '账号不存在' }, 404, cors);
    if (password.length < 6) return json({ error: '密码至少 6 位' }, 400, cors);
    const salt = randomSalt();
    state.users[target].salt = salt;
    state.users[target].hash = await derivePassword(password, salt);
    state.users[target].updatedAt = new Date().toISOString();
    await saveState(env, state, ctx);
    return json({ ok: true, message: `已重置「${target}」的密码` }, 200, cors);
  }

  return json({ error: 'Not Found' }, 404, cors);
}

const FALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>社团 DeepSeek 后端</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.7;color:#222}
code{background:#f2f2f4;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>社团 DeepSeek 后端</h1>
<p>这是 API 服务，网页界面在 GitHub Pages 上。</p>
<p>自检：<a href="/api/health">/api/health</a> 应该返回 <code>{"ok":true,"mode":"server"}</code></p>
</body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (pathname === '/api/health') {
        return json(
          { ok: true, mode: 'server', service: 'shetuankaifang', storage: env.USERS ? 'kv' : 'memory' },
          200,
          cors,
        );
      }

      if (pathname === '/api/login') {
        if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
        return await handleLogin(request, env, ctx, cors);
      }

      if (pathname.startsWith('/api/admin/')) {
        return await handleAdmin(request, env, ctx, pathname, cors);
      }

      if (pathname.startsWith('/api/')) {
        const header = String(request.headers.get('Authorization') || '');
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const payload = await verifyToken(env, token);
        if (!payload) return json({ error: '登录状态已失效，请重新登录', code: 'UNAUTHORIZED' }, 401, cors);

        const state = await ensureUsers(env, ctx);
        const account = state.users[payload.u];
        if (!account) return json({ error: '账号不存在，请重新登录', code: 'UNAUTHORIZED' }, 401, cors);

        if (pathname === '/api/me') return json({ ok: true, user: userView(account) }, 200, cors);

        if (pathname === '/api/password') {
          if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
          return await handlePasswordChange(request, env, ctx, account, cors);
        }

        if (pathname === '/api/sessions') {
          if (request.method === 'GET') {
            const sessions = await readHistory(env, payload.u);
            return json({ ok: true, sessions, count: sessions.length }, 200, cors);
          }
          if (request.method === 'PUT' || request.method === 'POST') {
            let input;
            try {
              input = await request.json();
            } catch (err) {
              return json({ error: `请求格式错误：${err.message}` }, 400, cors);
            }
            const sessions = input && Array.isArray(input.sessions) ? input.sessions : null;
            if (!sessions) return json({ error: 'sessions 必须是数组' }, 400, cors);
            await writeHistory(env, payload.u, sessions);
            return json({ ok: true, count: sessions.length }, 200, cors);
          }
          return json({ error: 'Method Not Allowed' }, 405, cors);
        }

        if (pathname === '/api/config') {
          if (request.method !== 'GET') return json({ error: '本站的 Key 由服务器统一管理，无法在页面里修改' }, 403, cors);
          return json(
            {
              hasKey: Boolean(env.DEEPSEEK_API_KEY),
              baseUrl: env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
              model: env.DEFAULT_MODEL || 'deepseek-chat',
              systemPrompt: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
              temperature: Number(env.TEMPERATURE || 1),
              server: true,
              user: userView(account),
            },
            200,
            cors,
          );
        }

        if (pathname === '/api/models') return await handleModels(env, cors);
        if (pathname === '/api/test') return await handleTest(env, cors);

        if (pathname === '/api/chat') {
          if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
          const fresh = await loadState(env);
          const live = fresh.users[payload.u] || account;
          return await handleChat(request, env, ctx, live, cors);
        }

        return json({ error: 'Not Found' }, 404, cors);
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        return new Response(FALLBACK_PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return json({ error: 'Method Not Allowed' }, 405, cors);
    } catch (err) {
      return json({ error: err.message || '服务器内部错误' }, 500, cors);
    }
  },
};
