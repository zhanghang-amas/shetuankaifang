/*!
 * 运行环境适配器 · runtime.js
 *
 * 同一个前端跑在两种形态下，启动时自动判断：
 *
 *   1. 社团服务器（server/server.mjs）
 *      - 先登录（用户名 + 密码），拿到 Bearer token
 *      - Key 在服务器，浏览器拿不到
 *      - 每个账号有 token 额度，界面上显示剩余
 *
 *   2. GitHub Pages 纯静态
 *      - 浏览器直连 api.deepseek.com
 *      - 每个访客填自己的 Key，存在 localStorage
 *
 * 后端地址写在 config.js 的 window.DS_API_BASE；留空则用同源。
 */

(() => {
  'use strict';

  const API_BASE = String(window.DS_API_BASE || '').trim().replace(/\/+$/, '');
  const CONFIG_KEY = 'ds-web-config';
  const AUTH_KEY = 'ds-auth';
  const FALLBACK_MODELS = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ];
  const DEFAULT_CONFIG = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    systemPrompt: '你是一个乐于助人的 AI 助手，请用简体中文回答，回答要准确、简洁。',
    temperature: 1.0,
  };

  const nativeFetch = window.fetch.bind(window);
  const $ = (id) => document.getElementById(id);
  const apiUrl = (path) => (API_BASE ? API_BASE + path : path);

  let mode = 'static';
  let currentUser = null;
  let loginWaiter = null;
  let gateBound = false;

  /* ================================================================== */
  /* 静态模式：本地配置                                                   */
  /* ================================================================== */

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      return { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(patch) {
    const next = { ...loadConfig(), ...patch };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下可能写不进去 */
    }
    return next;
  }

  function publicConfig(cfg) {
    return {
      hasKey: Boolean(cfg.apiKey),
      keyHint: cfg.apiKey
        ? `${String(cfg.apiKey).slice(0, 4)}••••${String(cfg.apiKey).slice(-4)}`
        : '',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      temperature: cfg.temperature,
    };
  }

  function normalizeBaseUrl(input) {
    const value = String(input || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(value)) {
      throw new Error('API 地址需要以 http:// 或 https:// 开头');
    }
    return value;
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  async function staticConfig(init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'GET') return json(publicConfig(loadConfig()));

    let input;
    try {
      input = JSON.parse((init && init.body) || '{}');
    } catch {
      return json({ error: '请求体不是合法的 JSON' }, 400);
    }

    const patch = {};
    if (typeof input.apiKey === 'string') {
      patch.apiKey = input.apiKey === '__CLEAR__' ? '' : input.apiKey.trim();
    }
    if (typeof input.baseUrl === 'string') {
      try {
        patch.baseUrl = normalizeBaseUrl(input.baseUrl);
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }
    if (typeof input.systemPrompt === 'string') patch.systemPrompt = input.systemPrompt.slice(0, 8000);
    if (typeof input.model === 'string') patch.model = input.model;
    if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
      patch.temperature = Math.min(2, Math.max(0, input.temperature));
    }

    return json({ ok: true, config: publicConfig(saveConfig(patch)) });
  }

  async function upstreamModels(cfg) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await nativeFetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, status: res.status, models: FALLBACK_MODELS };
      const data = await res.json();
      const models = (Array.isArray(data && data.data) ? data.data : [])
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({ id: m.id, name: m.name || m.id }));
      return { ok: true, status: res.status, models: models.length ? models : FALLBACK_MODELS };
    } catch (err) {
      return { ok: false, status: 0, models: FALLBACK_MODELS, error: err };
    } finally {
      clearTimeout(timer);
    }
  }

  async function staticModels() {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      return json({ models: FALLBACK_MODELS, source: 'fallback', message: '还没有配置 Key' });
    }
    try {
      normalizeBaseUrl(cfg.baseUrl);
    } catch (err) {
      return json({ models: FALLBACK_MODELS, source: 'fallback', message: err.message });
    }
    const result = await upstreamModels(cfg);
    if (result.ok) return json({ models: result.models, source: 'live' });
    return json({
      models: FALLBACK_MODELS,
      source: 'fallback',
      message: result.status ? `上游 HTTP ${result.status}` : '网络无法连接',
    });
  }

  async function staticTest() {
    const cfg = loadConfig();
    if (!cfg.apiKey) return json({ ok: false, message: '还没有保存 API Key' });
    const started = Date.now();
    const result = await upstreamModels(cfg);
    if (result.ok) {
      return json({
        ok: true,
        message: `连接正常：HTTP ${result.status}，${result.models.length} 个模型，${Date.now() - started}ms`,
      });
    }
    if (!result.status) {
      return json({ ok: false, message: `连接失败：${result.error ? result.error.message : '网络错误'}` });
    }
    if (result.status === 401) return json({ ok: false, message: 'API Key 无效或已过期' });
    if (result.status === 402) return json({ ok: false, message: 'DeepSeek 账户余额不足' });
    return json({ ok: false, message: `上游返回 HTTP ${result.status}` });
  }

  async function staticChat(init) {
    let payload;
    try {
      payload = JSON.parse((init && init.body) || '{}');
    } catch (err) {
      return json({ error: `请求格式错误：${err.message}` }, 400);
    }

    const cfg = loadConfig();
    if (!cfg.apiKey) {
      return json({ error: '还没有配置 API Key。点击右上角「设置」填入 DeepSeek 的 API Key。' }, 400);
    }

    const history = Array.isArray(payload.messages) ? payload.messages : [];
    const messages = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-60)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 100000) }));
    if (!messages.length) return json({ error: '没有可发送的消息' }, 400);

    const systemPrompt = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt.trim() : '';
    if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });

    const requested = typeof payload.model === 'string' ? payload.model.trim() : '';
    const model = requested || cfg.model;
    const body = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (!/reason/i.test(model)) body.temperature = cfg.temperature;

    let endpoint;
    try {
      endpoint = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`;
    } catch (err) {
      return json({ error: `API 地址无效：${err.message}` }, 400);
    }

    let upstream;
    try {
      upstream = await nativeFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: init && init.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return new Response(null, { status: 499 });
      return json({ error: `无法连接 DeepSeek：${err.message}。请检查网络，或到「设置」里确认 API 地址。` }, 502);
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
      if (upstream.status === 401) message = 'API Key 无效或已过期，请到「设置」里检查。';
      if (upstream.status === 402) message = 'DeepSeek 账户余额不足，请先充值。';
      if (upstream.status === 429) message = '请求太频繁或额度耗尽，请稍后再试。';
      return json({ error: message }, 502);
    }

    return upstream;
  }

  function installStaticFetch() {
    const routes = { config: staticConfig, models: staticModels, test: staticTest, chat: staticChat };
    window.fetch = function patchedFetch(input, init) {
      let url;
      try {
        url = new URL(typeof input === 'string' ? input : input.url, document.baseURI);
      } catch {
        return nativeFetch(input, init);
      }
      const matched = url.pathname.match(/\/api\/(config|models|test|chat)$/);
      if (!matched) return nativeFetch(input, init);
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (matched[1] === 'chat' && method !== 'POST') {
        return Promise.resolve(json({ error: 'Method Not Allowed' }, 405));
      }
      return Promise.resolve(routes[matched[1]](init));
    };
  }

  /* ================================================================== */
  /* 服务端模式：账号 / 额度                                              */
  /* ================================================================== */

  function getAuth() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY)) || null;
    } catch {
      return null;
    }
  }

  function setAuth(value) {
    try {
      if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
      else localStorage.removeItem(AUTH_KEY);
    } catch {
      /* 隐私模式忽略 */
    }
  }

  const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');

  function fmtWan(n) {
    const value = Number(n || 0);
    if (value >= 1_000_000) return `${(value / 10_000).toFixed(0)} 万`;
    if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
    return String(value);
  }

  function applyUser(user) {
    if (!user) return;
    currentUser = user;

    const chip = $('quotaChip');
    if (chip) {
      chip.hidden = false;
      chip.textContent = `剩余 ${fmtWan(user.remaining)}`;
      chip.title = `已用 ${fmtNum(user.used)} / 上限 ${fmtNum(user.quota)} tokens`;
      chip.classList.toggle('low', Number(user.remaining) < 100000);
    }

    const name = $('accName');
    if (name) name.textContent = user.name || '—';
    const used = $('accUsed');
    if (used) used.textContent = `${fmtNum(user.used)} tokens`;
    const quota = $('accQuota');
    if (quota) quota.textContent = `${fmtNum(user.quota)} tokens`;
    const remaining = $('accRemaining');
    if (remaining) remaining.textContent = `${fmtNum(user.remaining)} tokens`;
    const bar = $('accBar');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(user.percent) || 0))}%`;
    const tip = $('accTip');
    if (tip) {
      tip.textContent = Number(user.remaining) <= 0
        ? '额度已用完，请联系社团管理员。'
        : `已使用 ${user.percent || 0}%，用完后需要管理员重置。`;
    }
  }

  async function refreshQuota() {
    const auth = getAuth();
    if (!auth || !auth.token) return;
    try {
      const res = await window.fetch('/api/me');
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.user) applyUser(data.user);
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 登录门 ---------------- */

  function showGate(message) {
    const gate = $('authGate');
    if (!gate) return;
    gate.hidden = false;
    document.body.classList.add('auth-locked');
    const err = $('authErr');
    if (err && message) err.textContent = message;
    const input = $('authUser');
    if (input && !input.value) setTimeout(() => input.focus(), 60);
  }

  function hideGate() {
    const gate = $('authGate');
    if (gate) gate.hidden = true;
    document.body.classList.remove('auth-locked');
  }

  function waitLogin() {
    return new Promise((resolve) => {
      loginWaiter = resolve;
    });
  }

  function bindGate() {
    if (gateBound) return;
    gateBound = true;

    const form = $('authForm');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const userInput = $('authUser');
      const passInput = $('authPass');
      const button = $('authSubmit');
      const err = $('authErr');

      const username = (userInput && userInput.value || '').trim();
      const password = (passInput && passInput.value) || '';
      if (!username || !password) {
        if (err) err.textContent = '请输入用户名和密码';
        return;
      }

      if (button) {
        button.disabled = true;
        button.textContent = '登录中…';
      }
      if (err) err.textContent = '';

      try {
        const res = await nativeFetch(apiUrl('/api/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (err) err.textContent = data.error || `登录失败（HTTP ${res.status}）`;
          return;
        }
        setAuth({ token: data.token, user: data.user, at: Date.now() });
        applyUser(data.user);
        hideGate();
        if (passInput) passInput.value = '';
        if (loginWaiter) {
          const resolve = loginWaiter;
          loginWaiter = null;
          resolve();
        }
      } catch (error) {
        if (err) err.textContent = `无法连接服务器：${error.message}`;
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = '进入';
        }
      }
    });
  }

  async function ensureLogin() {
    bindGate();
    const auth = getAuth();
    if (auth && auth.token) {
      try {
        const res = await nativeFetch(apiUrl('/api/me'), {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (res.ok) {
          const data = await res.json();
          applyUser(data.user || auth.user);
          return;
        }
      } catch {
        /* 网络问题：继续走登录页 */
      }
      setAuth(null);
    }
    showGate();
    await waitLogin();
  }

  /* ---------------- 账号弹窗 ---------------- */

  function installServerUi() {
    // 服务端模式下 Key 是服务器管的，原来的「设置」弹窗没有意义：
    // 留在 DOM 里（app.js 还要绑定事件）但永远不显示
    const settingsModal = $('settingsModal');
    if (settingsModal) {
      settingsModal.hidden = true;
      settingsModal.style.display = 'none';
    }

    for (const id of ['settingsBtn', 'topSettingsBtn']) {
      const button = $(id);
      if (!button) continue;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        openAccount();
      }, true);
    }

    const modal = $('accountModal');
    if (modal) {
      const close = $('closeAccount');
      if (close) close.addEventListener('click', () => { modal.hidden = true; });
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.hidden = true;
      });
    }

    const logout = $('logoutBtn');
    if (logout) {
      logout.addEventListener('click', () => {
        if (!window.confirm('确定退出登录吗？')) return;
        setAuth(null);
        location.reload();
      });
    }
  }

  function openAccount() {
    const modal = $('accountModal');
    if (!modal) return;
    modal.hidden = false;
    refreshQuota();
  }

  /* ---------------- fetch 接管 ---------------- */

  function handleUnauthorized() {
    const gate = $('authGate');
    if (gate && !gate.hidden) return; // 已经在登录页，别重复触发
    setAuth(null);
    showGate('登录状态已失效，请重新登录');
  }

  function installServerFetch() {
    window.fetch = function patchedFetch(input, init = {}) {
      let url;
      try {
        url = new URL(typeof input === 'string' ? input : input.url, document.baseURI);
      } catch {
        return nativeFetch(input, init);
      }

      const matched = url.pathname.match(/\/api\/(config|models|test|chat|me|logout)$/);
      if (!matched) return nativeFetch(input, init);

      const target = apiUrl(`/api/${matched[1]}${url.search || ''}`);
      const headers = new Headers(init.headers || {});
      const auth = getAuth();
      if (auth && auth.token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${auth.token}`);
      }

      const request = nativeFetch(target, { ...init, headers }).then((res) => {
        if (res.status === 401) handleUnauthorized();
        if (matched[1] !== 'chat' || !res.ok || !res.body || typeof TransformStream === 'undefined') {
          return res;
        }
        // 聊天流结束后刷新一次剩余额度
        const monitored = res.body.pipeThrough(new TransformStream({
          flush() {
            refreshQuota();
          },
        }));
        return new Response(monitored, { status: res.status, headers: res.headers });
      });

      return request;
    };
  }

  /* ================================================================== */
  /* 启动探测                                                             */
  /* ================================================================== */

  async function detect() {
    if (API_BASE) {
      mode = 'server';
    } else {
      try {
        const probe = new URL('api/health', document.baseURI).href;
        const res = await nativeFetch(probe, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const data = await res.json().catch(() => null);
          if (data && data.ok === true && data.mode === 'server') mode = 'server';
        }
      } catch {
        /* 探测失败即静态模式 */
      }
    }

    document.documentElement.dataset.mode = mode;

    if (mode === 'server') {
      installServerFetch();
      installServerUi();
      await ensureLogin();
    } else {
      installStaticFetch();
    }

    return mode;
  }

  // app.js 会先 await 这个 Promise：登录完成、模式确定后才开始初始化
  window.__DS_BACKEND_READY = detect();
  window.__DS_MODE = () => mode;
  window.__DS_USER = () => currentUser;
})();
