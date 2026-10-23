/*!
 * 双模式适配器 · static-adapter.js
 *
 * 同一个前端要跑在两种环境里：
 *   1. GitHub Pages（纯静态托管，没有后端）
 *      → 浏览器直连 https://api.deepseek.com，Key 存在访客自己的 localStorage
 *   2. Node 服务（server/server.mjs）
 *      → 沿用 /api/* 接口，Key 存在服务器 data/config.json
 *
 * 用法：启动时探测一次 /api/health。
 *   探测到 200 + JSON → 服务端模式，什么都不做，保持原样；
 *   探测失败/404      → 静态模式，接管 window.fetch 里的 /api/* 请求。
 */

(() => {
  'use strict';

  const CONFIG_KEY = 'ds-web-config';
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
  let mode = 'static';

  /* ---------------- 配置存取（静态模式用 localStorage） ---------------- */

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
      /* 隐私模式下可能写不进去，忽略 */
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

  /* ---------------- 各接口的静态实现 ---------------- */

  async function handleConfig(init) {
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

  async function listModels(cfg) {
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

  async function handleModels() {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      return json({ models: FALLBACK_MODELS, source: 'fallback', message: '还没有配置 Key' });
    }
    try {
      normalizeBaseUrl(cfg.baseUrl);
    } catch (err) {
      return json({ models: FALLBACK_MODELS, source: 'fallback', message: err.message });
    }
    const result = await listModels(cfg);
    if (result.ok) return json({ models: result.models, source: 'live' });
    return json({
      models: FALLBACK_MODELS,
      source: 'fallback',
      message: result.status ? `上游 HTTP ${result.status}` : '网络无法连接',
    });
  }

  async function handleTest(init) {
    const cfg = loadConfig();
    if (!cfg.apiKey) return json({ ok: false, message: '还没有保存 API Key' });
    const started = Date.now();
    const result = await listModels(cfg);
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

  async function handleChat(init) {
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

    // 直接返回上游的 SSE 流，前端按原有逻辑逐段解析
    return upstream;
  }

  /* ---------------- 接管 fetch ---------------- */

  const ROUTES = {
    config: handleConfig,
    models: handleModels,
    test: handleTest,
    chat: handleChat,
  };

  function install() {
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
      const handler = ROUTES[matched[1]];
      if (matched[1] === 'chat' && method !== 'POST') {
        return Promise.resolve(json({ error: 'Method Not Allowed' }, 405));
      }
      return Promise.resolve(handler(init));
    };
  }

  /* ---------------- 启动探测 ---------------- */

  async function detect() {
    try {
      const probe = new URL('api/health', document.baseURI).href;
      const res = await nativeFetch(probe, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        const data = await res.json().catch(() => null);
        if (data && data.ok === true) mode = 'server';
      }
    } catch {
      /* 探测失败即静态模式 */
    }

    document.documentElement.dataset.mode = mode;
    if (mode === 'static') install();
    return mode;
  }

  // app.js 会 await 这个 Promise，确保模式确定后再发第一个请求
  window.__DS_BACKEND_READY = detect();
  window.__DS_MODE = () => mode;
})();
