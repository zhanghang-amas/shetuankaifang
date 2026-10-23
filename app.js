/* 本地 DeepSeek 助手 · 前端逻辑（无框架、无依赖） */
(() => {
  'use strict';

  const STORE_KEY = 'ds-local-chat-v2';
  const MODEL_KEY = 'ds-local-model';
  const SETUP_KEY = 'ds-local-setup-seen';
  const THEME_KEY = 'ds-theme';
  const ACCENT_KEY = 'ds-accent';

  const $ = (id) => document.getElementById(id);
  const el = {
    chat: $('chat'),
    messages: $('messages'),
    welcome: $('welcome'),
    history: $('history'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    modelSelect: $('modelSelect'),
    connState: $('connState'),
    sidebar: $('sidebar'),
    backdrop: $('backdrop'),
    toast: $('toast'),
    modal: $('settingsModal'),
    apiKey: $('apiKey'),
    baseUrl: $('baseUrl'),
    systemPrompt: $('systemPrompt'),
    keyHint: $('keyHint'),
    chips: $('chips'),
    testBtn: $('testBtn'),
    testResult: $('testResult'),
    themeBtn: $('themeBtn'),
    themePop: $('themePop'),
    themeSeg: $('themeSeg'),
    swatches: $('swatches'),
  };

  let serverConfig = {
    hasKey: false,
    keyHint: '',
    baseUrl: 'https://api.deepseek.com',
    systemPrompt: '',
    model: 'deepseek-chat',
  };
  let sessions = [];
  let currentId = null;
  let model = localStorage.getItem(MODEL_KEY) || 'deepseek-chat';
  let streaming = false;
  let abortController = null;
  let live = null;
  let saveTimer = null;

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const ACCENTS = ['blue', 'violet', 'teal', 'green', 'amber', 'rose'];
  let themeMode = localStorage.getItem(THEME_KEY) || 'system';
  let accent = localStorage.getItem(ACCENT_KEY) || 'blue';
  if (!['light', 'dark', 'system'].includes(themeMode)) themeMode = 'system';
  if (!ACCENTS.includes(accent)) accent = 'blue';

  /* ------------------------------------------------------------------ */
  /* 存储                                                                */
  /* ------------------------------------------------------------------ */

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.messages));
    } catch {
      return [];
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
      } catch {
        toast('浏览器存储已满，历史记录可能无法保存');
      }
    }, 250);
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function current() {
    return sessions.find((s) => s.id === currentId) || null;
  }

  function createSession(activate = true) {
    const session = { id: uid(), title: '新对话', messages: [], updatedAt: Date.now() };
    sessions.unshift(session);
    if (activate) currentId = session.id;
    persist();
    return session;
  }

  // 空白"新对话"只保留当前这一个，避免点一次就多一条空记录
  function pruneEmptySessions(keepId) {
    const before = sessions.length;
    sessions = sessions.filter((s) => s.messages.length > 0 || s.id === keepId);
    if (sessions.length !== before) persist();
  }

  /* ------------------------------------------------------------------ */
  /* Markdown（先转义再渲染，防 XSS）                                      */
  /* ------------------------------------------------------------------ */

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function inlineMd(input) {
    const codes = [];
    let s = String(input);
    s = s.replace(/`([^`\n]+)`/g, (_, code) => `\u0001${codes.push(code) - 1}\u0001`);
    s = escapeHtml(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
    return s;
  }

  function isTableSeparator(line) {
    const t = line.trim();
    return t.includes('|') && t.includes('-') && /^[\s|:-]+$/.test(t);
  }

  function splitRow(row) {
    return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }

  function tableHtml(header, rows) {
    const head = header.map((c) => `<th>${inlineMd(c)}</th>`).join('');
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderMarkdown(src) {
    const blocks = [];
    const stash = (html) => {
      blocks.push(html);
      return `\u0002${blocks.length - 1}\u0002`;
    };

    let text = String(src ?? '').replace(/\r\n?/g, '\n');

    // 1. 代码块先摘出来，避免内部内容被当成 markdown
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const language = (lang || '').trim() || 'text';
      const clean = code.replace(/\n$/, '');
      return stash(
        `<div class="codeblock"><div class="codeblock-head"><span>${escapeHtml(language)}</span>`
        + `<button class="copy-btn" type="button" data-code="${encodeURIComponent(clean)}">复制</button></div>`
        + `<pre><code>${escapeHtml(clean)}</code></pre></div>`,
      );
    });

    const lines = text.split('\n');
    const out = [];
    let para = [];
    let listType = null;
    let listItems = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (!listType) return;
      out.push(`<${listType}>${listItems.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${listType}>`);
      listType = null;
      listItems = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.trim();

      if (!line) {
        flushPara();
        flushList();
        continue;
      }

      if (/^\u0002\d+\u0002$/.test(line)) {
        flushPara();
        flushList();
        out.push(line);
        continue;
      }

      // 表格
      if (line.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushPara();
        flushList();
        const header = splitRow(line);
        i += 1;
        const rows = [];
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
          i += 1;
          rows.push(splitRow(lines[i].trim()));
        }
        out.push(tableHtml(header, rows));
        continue;
      }

      // 标题
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        const level = Math.min(heading[1].length, 4);
        out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
        continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        flushPara();
        flushList();
        out.push('<hr>');
        continue;
      }

      // 引用
      if (/^>\s?/.test(line)) {
        flushPara();
        flushList();
        out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`);
        continue;
      }

      // 列表
      const ul = line.match(/^[-*+]\s+(.*)$/);
      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const type = ul ? 'ul' : 'ol';
        if (listType && listType !== type) flushList();
        listType = type;
        listItems.push((ul || ol)[1]);
        continue;
      }

      if (listType) flushList();
      para.push(line);
    }

    flushPara();
    flushList();

    return out.join('\n').replace(/\u0002(\d+)\u0002/g, (_, i) => blocks[+i] ?? '');
  }

  /* ------------------------------------------------------------------ */
  /* 消息渲染                                                             */
  /* ------------------------------------------------------------------ */

  function reasoningBlock(text, open) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    details.open = Boolean(open);
    const summary = document.createElement('summary');
    summary.textContent = '深度思考';
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    body.textContent = text;
    details.append(summary, body);
    return details;
  }

  function usageLine(usage) {
    const div = document.createElement('div');
    div.className = 'usage';
    const pin = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const pout = usage.completion_tokens ?? usage.output_tokens ?? 0;
    let text = `输入 ${pin} · 输出 ${pout} tokens`;
    if (usage.prompt_cache_hit_tokens) text += ` · 缓存命中 ${usage.prompt_cache_hit_tokens}`;
    div.textContent = text;
    return div;
  }

  function errorBox(text) {
    const div = document.createElement('div');
    div.className = 'error-box';
    div.textContent = text;
    return div;
  }

  function renderMessage(msg, index) {
    const node = document.createElement('div');
    node.className = `msg ${msg.role}`;
    node.dataset.index = String(index);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (msg.role === 'user') {
      bubble.textContent = msg.content;
    } else {
      if (msg.reasoning) bubble.appendChild(reasoningBlock(msg.reasoning, false));

      const md = document.createElement('div');
      md.className = 'md';
      if (msg.error) md.appendChild(errorBox(msg.error));
      else md.innerHTML = renderMarkdown(msg.content || '');
      bubble.appendChild(md);

      if (msg.usage) bubble.appendChild(usageLine(msg.usage));

      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const isLast = index === (current()?.messages.length ?? 0) - 1;
      actions.innerHTML = '<button class="mini-btn" type="button" data-act="copy">复制</button>'
        + (isLast ? '<button class="mini-btn" type="button" data-act="regen">重新生成</button>' : '');
      bubble.appendChild(actions);
    }

    node.appendChild(bubble);
    return node;
  }

  function renderMessages() {
    const session = current();
    el.messages.innerHTML = '';
    if (!session || session.messages.length === 0) {
      el.welcome.hidden = false;
      return;
    }
    el.welcome.hidden = true;
    session.messages.forEach((msg, i) => el.messages.appendChild(renderMessage(msg, i)));
    scrollToBottom(true);
  }

  function renderHistory() {
    el.history.innerHTML = '';
    const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '还没有对话';
      el.history.appendChild(empty);
      return;
    }
    sorted.forEach((session) => {
      const item = document.createElement('div');
      item.className = `history-item${session.id === currentId ? ' active' : ''}`;
      item.dataset.id = session.id;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.textContent = session.title || '新对话';
      open.title = session.title || '新对话';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除对话';

      item.append(open, del);
      el.history.appendChild(item);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 通用 UI                                                             */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message, opts = {}) {
    const strong = opts.strong === true;
    el.toast.textContent = message;
    el.toast.classList.toggle('strong', strong);
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => {
        el.toast.hidden = true;
        el.toast.classList.remove('strong');
      }, 200);
    }, strong ? 3200 : 2200);
  }

  function isNearBottom() {
    return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 140;
  }

  function scrollToBottom(force = false) {
    if (force || isNearBottom()) {
      el.chat.scrollTop = el.chat.scrollHeight;
    }
  }

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
  }

  function updateComposer() {
    el.sendBtn.classList.toggle('hidden', streaming);
    el.stopBtn.classList.toggle('hidden', !streaming);
    el.input.disabled = false;
  }

  function setConn(ok, text) {
    el.connState.textContent = text || (ok ? '已连接' : '未配置 Key');
    el.connState.classList.toggle('bad', !ok);
  }

  function openSidebar() {
    el.sidebar.classList.add('open');
    el.backdrop.hidden = false;
  }

  function closeSidebar() {
    el.sidebar.classList.remove('open');
    el.backdrop.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* 流式请求                                                             */
  /* ------------------------------------------------------------------ */

  function applyDelta(msg, json) {
    const choice = json.choices && json.choices[0];
    if (choice && choice.delta) {
      const delta = choice.delta;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        msg.reasoning = (msg.reasoning || '') + reasoning;
        ensureReasoningBlock();
      }
      if (typeof delta.content === 'string' && delta.content) {
        msg.content += delta.content;
        collapseReasoning();
      }
    }
    if (json.usage) msg.usage = json.usage;
  }

  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    setTimeout(() => {
      paintQueued = false;
      paintLive();
    }, 60);
  }

  function paintLive() {
    if (!live) return;
    const stick = isNearBottom();
    const msg = live.msg;
    if (live.reasoningBody) live.reasoningBody.textContent = msg.reasoning || '';
    if (msg.content) {
      live.mdEl.innerHTML = renderMarkdown(msg.content);
      const last = live.mdEl.lastElementChild;
      const cursor = '<span class="typing"></span>';
      if (last && last.tagName === 'P') last.insertAdjacentHTML('beforeend', cursor);
      else live.mdEl.insertAdjacentHTML('beforeend', cursor);
    } else {
      live.mdEl.innerHTML = '<span class="typing"></span>';
    }
    if (stick) scrollToBottom(true);
  }

  function ensureReasoningBlock() {
    if (!live || live.reasoningBody) return;
    const block = reasoningBlock(live.msg.reasoning, true);
    live.node.querySelector('.bubble').insertBefore(block, live.mdEl);
    live.reasoningBlock = block;
    live.reasoningBody = block.querySelector('.reasoning-body');
  }

  function collapseReasoning() {
    if (live && live.reasoningBlock && live.reasoningBlock.open) {
      live.reasoningBlock.open = false;
    }
  }

  async function runCompletion(session, history) {
    const msg = { role: 'assistant', content: '', reasoning: '' };
    session.messages.push(msg);

    const node = renderMessage(msg, session.messages.length - 1);
    el.messages.appendChild(node);
    el.welcome.hidden = true;

    live = {
      msg,
      node,
      mdEl: node.querySelector('.md'),
      reasoningBlock: null,
      reasoningBody: null,
    };

    streaming = true;
    updateComposer();
    scrollToBottom(true);

    abortController = new AbortController();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: history }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.error) throw new Error(json.error.message || '上游返回错误');
          applyDelta(msg, json);
        }
        schedulePaint();
      }

      paintFinal();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!msg.content && !msg.reasoning) {
          node.remove();
          session.messages.pop();
        } else {
          paintFinal();
        }
      } else {
        msg.error = err.message || '请求失败';
        msg.content = '';
        live.mdEl.innerHTML = '';
        live.mdEl.appendChild(errorBox(msg.error));
        if (live.reasoningBlock) live.reasoningBlock.open = false;
      }
    } finally {
      streaming = false;
      live = null;
      abortController = null;
      updateComposer();
      session.updatedAt = Date.now();
      persist();
      renderHistory();
      scrollToBottom();
    }
  }

  function paintFinal() {
    if (!live) return;
    const msg = live.msg;
    live.mdEl.innerHTML = msg.content ? renderMarkdown(msg.content) : '';

    if (live.reasoningBody) live.reasoningBody.textContent = msg.reasoning || '';

    if (!msg.content && !msg.reasoning) {
      live.mdEl.innerHTML = '<p class="empty-reply">（没有返回内容）</p>';
    }

    if (msg.usage) {
      const bubble = live.node.querySelector('.bubble');
      const actions = bubble.querySelector('.msg-actions');
      bubble.insertBefore(usageLine(msg.usage), actions);
    }

    if (live.reasoningBlock) live.reasoningBlock.open = false;
  }

  async function sendMessage(text) {
    const content = text.trim();
    if (!content || streaming) return;

    if (!serverConfig.hasKey) {
      // 页面可能是在保存 Key 之前加载的，发消息前再问一次服务端
      await refreshConfig();
      if (!serverConfig.hasKey) {
        openSettings();
        toast('请先填入 DeepSeek API Key');
        return;
      }
    }

    const session = current() || createSession();
    if (session.messages.length === 0) {
      session.title = content.replace(/\s+/g, ' ').slice(0, 28);
    }

    session.messages.push({ role: 'user', content });
    session.updatedAt = Date.now();

    el.messages.appendChild(renderMessage(session.messages[session.messages.length - 1], session.messages.length - 1));
    el.welcome.hidden = true;
    el.input.value = '';
    autoGrow();
    scrollToBottom(true);

    const history = session.messages
      .filter((m) => m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    persist();
    renderHistory();
    await runCompletion(session, history);
  }

  async function regenerate(index) {
    if (streaming) {
      toast('请先停止当前生成');
      return;
    }
    const session = current();
    if (!session) return;
    const target = session.messages[index];
    if (!target || target.role !== 'assistant') return;
    if (index !== session.messages.length - 1) {
      toast('只能重新生成最后一条回复');
      return;
    }

    session.messages.splice(index, 1);
    renderMessages();

    const history = session.messages
      .filter((m) => m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    if (!history.length) return;
    await runCompletion(session, history);
  }

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */

  function openSettings() {
    el.apiKey.value = '';
    el.apiKey.placeholder = serverConfig.hasKey
      ? `已保存 ${serverConfig.keyHint}，留空则不修改`
      : 'sk-...';
    el.baseUrl.value = serverConfig.baseUrl || 'https://api.deepseek.com';
    el.systemPrompt.value = serverConfig.systemPrompt || '';
    el.keyHint.textContent = serverConfig.hasKey
      ? 'Key 已保存在这台设备上，不会发送到浏览器。'
      : '在 platform.deepseek.com 创建，保存后即可开始对话。';
    if (el.testResult) {
      el.testResult.hidden = true;
      el.testResult.textContent = '';
      el.testResult.className = 'test-result';
    }
    el.modal.hidden = false;
    el.modal.style.display = '';
    setTimeout(() => el.apiKey.focus(), 50);
  }

  function closeSettings() {
    el.modal.hidden = true;
    // 双保险：即使旧 CSS 被缓存，也能把弹窗关掉
    el.modal.style.display = 'none';
  }

  async function saveSettings() {
    const patch = {
      baseUrl: el.baseUrl.value.trim() || 'https://api.deepseek.com',
      systemPrompt: el.systemPrompt.value,
    };
    const key = el.apiKey.value.trim();
    if (key) patch.apiKey = key;

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      serverConfig = data.config;
      setConn(serverConfig.hasKey);
      closeSettings();
      toast('设置已保存');
      if (serverConfig.hasKey) {
        loadModels();
        testConnection(true);
      } else {
        toast('还没有配置 Key');
      }
    } catch (err) {
      toast(err.message);
    }
  }

  async function clearKey() {
    if (!window.confirm('确定清除本机保存的 API Key 吗？')) return;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '__CLEAR__' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      serverConfig = data.config;
      setConn(false, '未配置 Key');
      closeSettings();
      toast('已清除 Key');
    } catch (err) {
      toast(err.message);
    }
  }

  async function testConnection(showToast = false) {
    if (!el.testResult) return null;
    el.testResult.hidden = false;
    el.testResult.className = 'test-result';
    el.testResult.textContent = '正在测试连接…';
    try {
      const res = await fetch('/api/test');
      const data = await res.json();
      el.testResult.className = `test-result ${data.ok ? 'ok' : 'bad'}`;
      el.testResult.textContent = data.message || (data.ok ? '连接正常' : '连接失败');
      if (showToast) toast(data.message || (data.ok ? '连接正常' : '连接失败'));
      return data;
    } catch (err) {
      el.testResult.className = 'test-result bad';
      el.testResult.textContent = `测试失败：${err.message}`;
      if (showToast) toast(`测试失败：${err.message}`);
      return { ok: false };
    }
  }

  async function loadModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      if (!models.length) return;

      const previous = model;
      el.modelSelect.innerHTML = '';
      models.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name || item.id;
        el.modelSelect.appendChild(option);
      });

      if (!models.some((item) => item.id === previous)) {
        model = models[0].id;
        localStorage.setItem(MODEL_KEY, model);
      }
      el.modelSelect.value = model;
    } catch {
      /* 拉不到就保留写死的选项 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                             */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    el.input.addEventListener('input', autoGrow);

    el.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        sendMessage(el.input.value);
      }
    });

    el.sendBtn.addEventListener('click', () => sendMessage(el.input.value));

    el.stopBtn.addEventListener('click', () => {
      if (abortController) abortController.abort();
    });

    el.chips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      sendMessage(chip.dataset.prompt || '');
    });

    $('newChat').addEventListener('click', () => {
      if (streaming) {
        toast('请先停止当前生成');
        return;
      }
      const cur = current();
      pruneEmptySessions(cur ? cur.id : null);
      if (cur && cur.messages.length === 0) {
        // 已经在一个空白对话里，不再重复新建，并给出明显提示
        toast('已经有一个空白新对话了，先聊点什么吧', { strong: true });
        const btn = $('newChat');
        btn.classList.remove('nudge');
        void btn.offsetWidth;
        btn.classList.add('nudge');
        btn.addEventListener('animationend', () => btn.classList.remove('nudge'), { once: true });
        renderHistory();
        closeSidebar();
        el.input.focus();
        return;
      }
      createSession();
      renderHistory();
      renderMessages();
      closeSidebar();
      el.input.focus();
    });

    el.history.addEventListener('click', (event) => {
      const item = event.target.closest('.history-item');
      if (!item) return;
      const id = item.dataset.id;

      if (event.target.closest('.del')) {
        if (streaming && id === currentId) {
          toast('请先停止当前生成');
          return;
        }
        const target = sessions.find((s) => s.id === id);
        if (!target) return;
        if (!window.confirm(`删除对话「${target.title || '新对话'}」？`)) return;
        sessions = sessions.filter((s) => s.id !== id);
        if (currentId === id) {
          if (!sessions.length) createSession();
          else currentId = sessions[0].id;
        }
        persist();
        renderHistory();
        renderMessages();
        return;
      }

      if (streaming && id !== currentId) {
        toast('请先停止当前生成');
        return;
      }
      currentId = id;
      renderHistory();
      renderMessages();
      closeSidebar();
    });

    el.messages.addEventListener('click', async (event) => {
      const copyBtn = event.target.closest('.copy-btn');
      if (copyBtn) {
        const code = decodeURIComponent(copyBtn.dataset.code || '');
        const ok = await copyText(code);
        copyBtn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        return;
      }

      const action = event.target.closest('[data-act]');
      if (!action) return;
      const msgNode = action.closest('.msg');
      const index = Number(msgNode?.dataset.index);
      const session = current();
      if (!session || Number.isNaN(index)) return;

      if (action.dataset.act === 'copy') {
        const msg = session.messages[index];
        if (msg) {
          const ok = await copyText(msg.content);
          toast(ok ? '已复制' : '复制失败');
        }
      } else if (action.dataset.act === 'regen') {
        regenerate(index);
      }
    });

    el.modelSelect.addEventListener('change', () => {
      model = el.modelSelect.value;
      localStorage.setItem(MODEL_KEY, model);
    });

    $('settingsBtn').addEventListener('click', openSettings);
    $('topSettingsBtn').addEventListener('click', openSettings);
    $('closeSettings').addEventListener('click', closeSettings);
    $('cancelSettings').addEventListener('click', closeSettings);
    $('saveSettings').addEventListener('click', saveSettings);
    $('clearKeyBtn').addEventListener('click', clearKey);
    $('testBtn').addEventListener('click', () => testConnection(false));

    el.themeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleThemePop();
    });
    el.themePop.addEventListener('click', (event) => event.stopPropagation());
    el.themeSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-mode]');
      if (!btn) return;
      themeMode = btn.dataset.mode;
      localStorage.setItem(THEME_KEY, themeMode);
      applyTheme();
    });
    el.swatches.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-accent]');
      if (!btn) return;
      accent = btn.dataset.accent;
      localStorage.setItem(ACCENT_KEY, accent);
      applyTheme();
    });
    document.addEventListener('click', closeThemePop);
    const onSchemeChange = () => {
      if (themeMode === 'system') applyTheme();
    };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSchemeChange);
    else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);

    el.modal.addEventListener('click', (event) => {
      if (event.target === el.modal) closeSettings();
    });

    $('openSidebar').addEventListener('click', openSidebar);
    $('closeSidebar').addEventListener('click', closeSidebar);
    el.backdrop.addEventListener('click', closeSidebar);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!el.modal.hidden) closeSettings();
        else if (!el.themePop.hidden) closeThemePop();
        else closeSidebar();
      }
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  function currentTheme() {
    return themeMode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : themeMode;
  }

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = currentTheme();
    root.dataset.accent = accent;

    el.themeSeg.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === themeMode);
    });
    el.swatches.querySelectorAll('[data-accent]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.accent === accent);
    });
  }

  function toggleThemePop(force) {
    if (!el.themePop) return;
    const show = typeof force === 'boolean' ? force : el.themePop.hidden;
    el.themePop.hidden = !show;
    if (show) applyTheme();
  }

  function closeThemePop() {
    if (el.themePop) el.themePop.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function refreshConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      serverConfig = await res.json();
      setConn(serverConfig.hasKey);
      return serverConfig;
    } catch {
      return serverConfig;
    }
  }

  async function init() {
    // 先等运行环境探测完成：GitHub Pages 静态模式 / Node 服务模式
    if (window.__DS_BACKEND_READY) {
      try {
        await window.__DS_BACKEND_READY;
      } catch {
        /* 探测失败就按静态模式继续 */
      }
    }
    applyTheme();

    sessions = loadSessions();
    if (!sessions.length) createSession();
    if (!currentId || !sessions.some((s) => s.id === currentId)) currentId = sessions[0].id;
    pruneEmptySessions(currentId);

    bindEvents();
    renderHistory();
    renderMessages();
    autoGrow();
    updateComposer();
    if (![...el.modelSelect.options].some((o) => o.value === model)) {
      model = el.modelSelect.options[0]?.value || model;
    }
    el.modelSelect.value = model;

    try {
      const res = await fetch('/api/config');
      serverConfig = await res.json();
      if (serverConfig.model) {
        model = localStorage.getItem(MODEL_KEY) || serverConfig.model;
        if (![...el.modelSelect.options].some((o) => o.value === model)) {
          model = el.modelSelect.options[0]?.value || model;
        }
        el.modelSelect.value = model;
      }
      setConn(serverConfig.hasKey);
      if (serverConfig.hasKey) await loadModels();
    } catch {
      setConn(false, '服务未连接');
    }

    if (!serverConfig.hasKey && !localStorage.getItem(SETUP_KEY)) {
      localStorage.setItem(SETUP_KEY, '1');
      setTimeout(openSettings, 350);
    }

    el.input.focus();
  }

  window.addEventListener('error', (event) => {
    if (event.message) toast(`页面出错：${event.message}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    toast(`请求出错：${reason?.message || reason}`);
  });

  init();
})();
