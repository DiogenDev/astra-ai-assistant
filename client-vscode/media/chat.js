(function () {
  window.__aiAssistantFatalShown = false;
  function showFatal(err) {
    if (window.__aiAssistantFatalShown) {
      return;
    }
    window.__aiAssistantFatalShown = true;
    var text = 'AI Assistant webview error: ' + ((err && (err.stack || err.message)) || String(err));
    try {
      document.body.innerHTML = '';
      var pre = document.createElement('pre');
      pre.style.cssText = 'padding:10px;white-space:pre-wrap;color:var(--vscode-errorForeground);';
      pre.textContent = text;
      document.body.appendChild(pre);
    } catch (_) {
      // ignore
    }
  }
  window.addEventListener('error', function (event) {
    showFatal(event.error || event.message);
  });

  try {
    const hasVsCodeApi = typeof acquireVsCodeApi === 'function';
    const vscode = hasVsCodeApi
      ? acquireVsCodeApi()
      : {
          postMessage: function () {},
          getState: function () {
            return undefined;
          },
          setState: function () {},
        };

    function $(id) {
      return document.getElementById(id);
    }

    const messagesEl = $('messages');
    const inputEl = $('input');
    const statusEl = $('status');
    const sendBtn = $('send');
    const stopBtn = $('stop');
    const statsEl = $('stats');
    const reasoningSelect = $('reasoning');
    const providerSelect = $('provider');
    const brandEl = $('brand');
    const chatTitleEl = $('chat-title');
    const newChatBtn = $('newchat');
    const settingsBtn = $('settings-btn');
    const chatsToggle = $('chats-toggle');
    const chatDrawer = $('chat-drawer');
    const chatDrawerClose = $('chat-drawer-close');
    const chatsList = $('chats-list');
    const drawerNewChat = $('drawer-newchat');
    const tokensBtn = $('tokens-btn');
    const contextBtn = $('context-btn');
    const tokensPanel = $('tokens-panel');
    const tokensClose = $('tokens-close');
    const tokensContent = $('tokens-content');
    const contextPanel = $('context-panel');
    const contextClose = $('context-close');
    const contextContent = $('context-content');
    const attachBtn = $('attach');
    const attachMenu = $('attach-menu');
    const attachFile = $('attach-file');
    const attachPath = $('attach-path');
    const chipsEl = $('attachment-chips');
    const emptyEl = $('empty');
    const scrimEl = $('scrim');
    const confirmEl = $('confirm');
    const confirmText = $('confirm-text');
    const confirmOk = $('confirm-ok');
    const confirmCancel = $('confirm-cancel');
    const toastsEl = $('toasts');

    const DEFAULT_PROVIDER = 'auto';
    const DEFAULT_EFFORT = 'medium';
    const PROVIDERS = ['auto', 'deepseek', 'free'];
    const EFFORTS = ['auto', 'none', 'low', 'medium', 'high'];
    const DEFAULT_CONTEXT_LIMIT = 1000000;

    const SVG_ATTRS =
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
    const ICONS = {
      chats:
        '<svg ' +
        SVG_ATTRS +
        '><path d="M4 6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 2.5V12A2 2 0 0 1 4 10z"/><path d="M16.5 8H18a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5v2.5L14 16h-2"/></svg>',
      plus: '<svg ' + SVG_ATTRS + '><path d="M12 5v14M5 12h14"/></svg>',
      tokens:
        '<svg ' +
        SVG_ATTRS +
        '><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
      context:
        '<svg ' +
        SVG_ATTRS +
        '><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8M8 16h5"/></svg>',
      copy:
        '<svg ' +
        SVG_ATTRS +
        '><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
      edit:
        '<svg ' +
        SVG_ATTRS +
        '><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/></svg>',
      trash:
        '<svg ' +
        SVG_ATTRS +
        '><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/></svg>',
      close: '<svg ' + SVG_ATTRS + '><path d="M6 6l12 12M18 6L6 18"/></svg>',
      chevron: '<svg ' + SVG_ATTRS + '><path d="M9 6l6 6-6 6"/></svg>',
      attach:
        '<svg ' +
        SVG_ATTRS +
        '><path d="M20 11.5l-7.6 7.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.6-7.6"/></svg>',
      send: '<svg ' + SVG_ATTRS + '><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
      stop: '<svg ' + SVG_ATTRS + '><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
      check: '<svg ' + SVG_ATTRS + '><path d="M5 12l5 5L20 6"/></svg>',
    };

    let lastSettings = { provider: DEFAULT_PROVIDER, reasoningEffort: DEFAULT_EFFORT };
    let autoApplyFiles = true;
    let state = { chats: [], activeId: null };
    let attachments = [];
    let lastStats = null;
    let stream = null;
    let renderTimer = null;
    let confirmCallback = null;
    let toastSeq = 0;
    let pendingFiles = [];

    function uid() {
      return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function safeProvider(value) {
      const key = String(value || '').toLowerCase();
      return PROVIDERS.indexOf(key) >= 0 ? key : DEFAULT_PROVIDER;
    }

    function safeEffort(value) {
      const key = String(value || '').toLowerCase();
      return EFFORTS.indexOf(key) >= 0 ? key : DEFAULT_EFFORT;
    }

    function makeChat() {
      const time = Date.now();
      return {
        id: uid(),
        title: 'New chat',
        messages: [],
        provider: safeProvider(lastSettings.provider),
        reasoningEffort: safeEffort(lastSettings.reasoningEffort),
        createdAt: time,
        updatedAt: time,
      };
    }

    function sanitizeMessage(raw) {
      if (!raw || typeof raw.content !== 'string') {
        return null;
      }
      const role =
        raw.role === 'user' || raw.role === 'assistant' || raw.role === 'error'
          ? raw.role
          : 'assistant';
      const message = { role: role, content: raw.content };
      if (typeof raw.reasoning === 'string' && raw.reasoning) {
        message.reasoning = raw.reasoning;
      }
      return message;
    }

    function sanitizeChat(raw) {
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const messages = Array.isArray(raw.messages)
        ? raw.messages.map(sanitizeMessage).filter(Boolean)
        : [];
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'New chat',
        messages: messages,
        provider: safeProvider(raw.provider),
        reasoningEffort: safeEffort(raw.reasoningEffort),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        manualTitle: Boolean(raw.manualTitle),
      };
    }

    function loadState() {
      let saved = null;
      try {
        saved = vscode.getState ? vscode.getState() : null;
      } catch (_) {
        saved = null;
      }
      if (saved && Array.isArray(saved.chats)) {
        state.chats = saved.chats.map(sanitizeChat).filter(Boolean);
        state.activeId = typeof saved.activeId === 'string' ? saved.activeId : null;
      }
      if (!state.chats.length) {
        const chat = makeChat();
        state.chats.push(chat);
        state.activeId = chat.id;
      }
      if (!state.chats.some(function (chat) { return chat.id === state.activeId; })) {
        state.activeId = state.chats[0].id;
      }
    }

    function persist() {
      try {
        if (vscode.setState) {
          vscode.setState({ version: 1, chats: state.chats, activeId: state.activeId });
        }
      } catch (_) {
        // ignore persistence errors
      }
    }

    function activeChat() {
      let chat = null;
      for (const candidate of state.chats) {
        if (candidate.id === state.activeId) {
          chat = candidate;
          break;
        }
      }
      if (!chat) {
        chat = makeChat();
        state.chats.push(chat);
        state.activeId = chat.id;
      }
      return chat;
    }

    function findChat(id) {
      for (const chat of state.chats) {
        if (chat.id === id) {
          return chat;
        }
      }
      return null;
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    }

    function iconSpan(name, className) {
      const span = document.createElement('span');
      span.className = 'icon' + (className ? ' ' + className : '');
      span.innerHTML = ICONS[name] || '';
      return span;
    }

    function iconButton(name, label, className) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn' + (className ? ' ' + className : '');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.appendChild(iconSpan(name));
      return button;
    }

    const EXT_RE = /\.(py|pyi|js|jsx|mjs|cjs|ts|tsx|json|jsonc|md|txt|html|css|scss|sass|less|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|yml|yaml|toml|ini|cfg|conf|sh|bash|zsh|ps1|bat|cmd|sql|env|xml|svg)$/i;

    function looksLikeFilePath(value) {
      const text = String(value || '').trim().replace(/^['"]|['"]$/g, '');
      if (!text || text.length > 200 || /\s/.test(text)) {
        return false;
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        return false;
      }
      return EXT_RE.test(text) || text === '.env';
    }

    function fileLink(filePath, absPath) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'file-link';
      link.textContent = filePath;
      link.title = 'Open ' + filePath;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'openFile', path: filePath, absPath: absPath || null });
      });
      return link;
    }

    function addLink(text, url) {
      const node = el('div', 'msg link');
      const anchor = document.createElement('a');
      anchor.href = '#';
      anchor.className = 'md-link';
      anchor.textContent = text || url;
      anchor.title = url;
      anchor.addEventListener('click', function (event) {
        event.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: url });
      });
      node.appendChild(anchor);
      messagesEl.appendChild(node);
      scrollToBottom();
    }

    function setStatus(text) {
      if (statusEl) {
        statusEl.textContent = text || '';
      }
    }

    function applyProviderLabel(value) {
      if (brandEl) {
        brandEl.textContent = value === 'free' ? 'GPT 5.6 Terra' : 'GPT 6 Astra';
      }
    }

    function renderInline(parent, text) {
      const re = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]*\]\([^)]*\))/g;
      let last = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) {
          parent.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        const token = match[0];
        if (token.charAt(0) === '`' && token.charAt(token.length - 1) === '`') {
          const inner = token.slice(1, -1);
          const code = document.createElement('code');
          if (looksLikeFilePath(inner)) {
            code.appendChild(fileLink(inner));
          } else {
            code.textContent = inner;
          }
          parent.appendChild(code);
        } else if (token.indexOf('**') === 0) {
          const strong = document.createElement('strong');
          renderInline(strong, token.slice(2, -2));
          parent.appendChild(strong);
        } else if (token.charAt(0) === '*') {
          const em = document.createElement('em');
          renderInline(em, token.slice(1, -1));
          parent.appendChild(em);
        } else if (token.charAt(0) === '[') {
          const link = token.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
          if (link && /^https?:\/\//i.test(link[2])) {
            const anchor = document.createElement('a');
            anchor.href = '#';
            anchor.className = 'md-link';
            anchor.textContent = link[1];
            anchor.title = link[2];
            anchor.addEventListener('click', function (event) {
              event.preventDefault();
              vscode.postMessage({ type: 'openExternal', url: link[2] });
            });
            parent.appendChild(anchor);
          } else if (link && looksLikeFilePath(link[2])) {
            parent.appendChild(fileLink(link[2]));
          } else if (link) {
            parent.appendChild(document.createTextNode(link[1]));
          } else {
            parent.appendChild(document.createTextNode(token));
          }
        } else {
          parent.appendChild(document.createTextNode(token));
        }
        last = match.index + token.length;
      }
      if (last < text.length) {
        parent.appendChild(document.createTextNode(text.slice(last)));
      }
    }

    function renderMarkdown(container, text, allowApply) {
      container.textContent = '';
      const lines = String(text).split('\n');
      let index = 0;
      let listEl = null;

      function closeList() {
        listEl = null;
      }

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (/^```/.test(trimmed)) {
          closeList();
          const rest = trimmed.slice(3).trim();
          const fileMatch = rest.match(/file=(?:"([^"]+)"|'([^']+)'|(\S+))/);
          const filePath = fileMatch ? fileMatch[1] || fileMatch[2] || fileMatch[3] : '';
          const language =
            rest
              .replace(/file=(?:"[^"]+"|'[^']+'|\S+)/, '')
              .trim()
              .split(/\s+/)[0] || '';
          const codeLines = [];
          index += 1;
          while (index < lines.length && !/^```/.test(lines[index].trim())) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) {
            index += 1;
          }
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          if (language) {
            code.className = 'language-' + language;
          }
          code.textContent = codeLines.join('\n');
          pre.appendChild(code);

          if (!filePath) {
            container.appendChild(pre);
            continue;
          }

          const wrapper = el('div', 'code-block');
          const header = el('div', 'code-header');
          const pathEl = el('span', 'code-path');
          pathEl.appendChild(fileLink(filePath));
          header.appendChild(pathEl);
          if (autoApplyFiles) {
            header.appendChild(el('span', 'auto-badge', 'auto'));
          } else {
            const applyButton = document.createElement('button');
            applyButton.type = 'button';
            applyButton.className = 'apply-file';
            applyButton.appendChild(iconSpan('check'));
            applyButton.appendChild(document.createTextNode('Apply'));
            applyButton.disabled = !allowApply;
            applyButton.title = allowApply
              ? 'Create or update ' + filePath
              : 'Wait for the answer to finish';
            applyButton.addEventListener('click', function () {
              vscode.postMessage({
                type: 'applyFile',
                path: filePath,
                content: codeLines.join('\n'),
              });
            });
            header.appendChild(applyButton);
          }
          wrapper.appendChild(header);
          wrapper.appendChild(pre);
          container.appendChild(wrapper);
          continue;
        }

        const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          closeList();
          const node = el('div', 'md-h md-h' + heading[1].length);
          renderInline(node, heading[2]);
          container.appendChild(node);
          index += 1;
          continue;
        }

        if (/^(---+|\*\*\*+)$/.test(trimmed)) {
          closeList();
          container.appendChild(document.createElement('hr'));
          index += 1;
          continue;
        }

        const item = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
        if (item) {
          if (!listEl) {
            listEl = el('div', 'md-list');
            container.appendChild(listEl);
          }
          const row = el('div', 'md-item');
          const bullet = el('span', 'md-bullet', /^\d+\.$/.test(item[1]) ? item[1] : '\u2022');
          const body = document.createElement('span');
          renderInline(body, item[2]);
          row.appendChild(bullet);
          row.appendChild(body);
          listEl.appendChild(row);
          index += 1;
          continue;
        }

        const quote = trimmed.match(/^>\s?(.*)$/);
        if (quote) {
          closeList();
          const node = el('div', 'md-quote');
          renderInline(node, quote[1]);
          container.appendChild(node);
          index += 1;
          continue;
        }

        if (!trimmed) {
          closeList();
          index += 1;
          continue;
        }

        closeList();
        let paragraph = line;
        index += 1;
        while (
          index < lines.length &&
          lines[index].trim() &&
          !/^```/.test(lines[index].trim()) &&
          !/^(#{1,4})\s+/.test(lines[index].trim()) &&
          !/^([-*]|\d+\.)\s+/.test(lines[index].trim()) &&
          !/^>\s?/.test(lines[index].trim())
        ) {
          paragraph += '\n' + lines[index];
          index += 1;
        }
        const p = el('div', 'md-p');
        renderInline(p, paragraph);
        container.appendChild(p);
      }
    }

    function isNearBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function scrollIfNearBottom() {
      if (isNearBottom()) {
        scrollToBottom();
      }
    }

    function scheduleRender() {
      if (renderTimer || !stream) {
        return;
      }
      renderTimer = setTimeout(function () {
        renderTimer = null;
        if (stream && stream.el) {
          renderMarkdown(stream.el, stream.current, false);
          scrollIfNearBottom();
        }
      }, 60);
    }

    function buildReasoning(text) {
      const details = document.createElement('details');
      details.className = 'reasoning';
      const summary = document.createElement('summary');
      summary.appendChild(iconSpan('chevron', 'chev'));
      const label = el('span', 'reasoning-label', 'Reasoning \u00b7 ' + String(text || '').length + ' chars');
      summary.appendChild(label);
      const body = el('div', 'reasoning-body', text || '');
      details.appendChild(summary);
      details.appendChild(body);
      return { details: details, summary: summary, label: label, body: body };
    }

    function appendReasoningStatic(text) {
      if (!text) {
        return;
      }
      messagesEl.appendChild(buildReasoning(text).details);
    }

    function endReasoning() {
      if (stream && stream.reasoningLabel) {
        stream.reasoningLabel.textContent =
          'Reasoning \u00b7 ' + stream.reasoningChars + ' chars';
      }
      if (stream) {
        stream.reasoningBlock = null;
        stream.reasoningBody = null;
        stream.reasoningLabel = null;
        stream.reasoningSummary = null;
      }
    }

    function appendReasoning(text) {
      if (!stream) {
        beginStream(activeChat());
      }
      if (!stream.reasoningBlock) {
        const built = buildReasoning('');
        messagesEl.insertBefore(built.details, stream.el);
        stream.reasoningBlock = built.details;
        stream.reasoningSummary = built.summary;
        stream.reasoningLabel = built.label;
        stream.reasoningBody = built.body;
        stream.reasoningChars = 0;
      }
      stream.reasoningChars += text.length;
      stream.reasoningText += text;
      stream.reasoningLabel.textContent =
        'Reasoning \u00b7 ' + stream.reasoningChars + ' chars';
      stream.reasoningBody.textContent += text;
      scrollIfNearBottom();
    }

    function diffChevron() {
      return iconSpan('chevron', 'chev');
    }

    function addDiff(info) {
      if (!info || !info.diff) {
        return;
      }
      if (info.path) {
        const bucket = stream ? stream.changedFiles : pendingFiles;
        if (
          !bucket.some(function (file) {
            return file.path === info.path;
          })
        ) {
          bucket.push({ path: info.path, absPath: info.abs_path || null });
        }
      }

      const details = document.createElement('details');
      details.className = 'edit';
      details.open = true;

      const summary = document.createElement('summary');
      summary.appendChild(diffChevron());
      const label = el('span', 'edit-label', info.created ? 'New file' : 'Edit file');
      const pathEl = el('span', 'edit-path');
      pathEl.appendChild(fileLink(info.path || 'file', info.abs_path));
      const counts = el(
        'span',
        'edit-counts',
        '+' + (info.added || 0) + ' -' + (info.removed || 0)
      );
      summary.appendChild(label);
      summary.appendChild(pathEl);
      summary.appendChild(counts);
      details.appendChild(summary);

      const body = el('div', 'diff-body');
      const lines = String(info.diff).split('\n');
      for (const line of lines) {
        const row = el('div', 'diff-line', line || ' ');
        if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) {
          row.classList.add('meta');
        } else if (line.charAt(0) === '+') {
          row.classList.add('add');
        } else if (line.charAt(0) === '-') {
          row.classList.add('del');
        } else if (line.indexOf('@@') === 0) {
          row.classList.add('hunk');
        }
        body.appendChild(row);
      }
      details.appendChild(body);
      messagesEl.appendChild(details);
      scrollIfNearBottom();
    }

    function filesBox(labelText, files) {
      if (!files.length) {
        return null;
      }
      const box = el('div', 'files');
      box.appendChild(el('div', 'files-label', labelText));
      const list = el('div', 'files-list');
      for (const file of files) {
        const chip = el('span', 'file-chip');
        chip.appendChild(fileLink(file.path, file.absPath));
        list.appendChild(chip);
      }
      box.appendChild(list);
      return box;
    }

    function showChangedFiles(files) {
      const box = filesBox('Files', files || []);
      if (box) {
        messagesEl.appendChild(box);
        scrollIfNearBottom();
      }
    }

    function addAppliedFile(filePath) {
      if (!filePath) {
        return;
      }
      const box = filesBox('Applied', [{ path: filePath }]);
      if (box) {
        messagesEl.appendChild(box);
        scrollIfNearBottom();
      }
    }

    function addAppliedFiles(paths) {
      if (!paths || !paths.length) {
        return;
      }
      const box = filesBox(
        'Applied',
        paths.map(function (filePath) {
          return { path: String(filePath) };
        })
      );
      if (box) {
        messagesEl.appendChild(box);
        scrollIfNearBottom();
      }
    }

    function fmtTokens(n) {
      n = Number(n) || 0;
      if (n >= 1000000) {
        return (n / 1000000).toFixed(2) + 'M';
      }
      if (n >= 1000) {
        return (n / 1000).toFixed(1) + 'k';
      }
      return String(n);
    }

    function fmtCount(n) {
      n = Number(n) || 0;
      if (n >= 1000000) {
        return (n / 1000000).toFixed(1) + 'M';
      }
      if (n >= 1000) {
        return (n / 1000).toFixed(1) + 'k';
      }
      return String(n);
    }

    function fmtCost(v) {
      v = Number(v) || 0;
      if (v === 0) {
        return '$0';
      }
      if (v < 0.0001) {
        return '$' + v.toFixed(6);
      }
      if (v < 0.01) {
        return '$' + v.toFixed(5);
      }
      return '$' + v.toFixed(4);
    }

    function renderStats(stats) {
      if (!stats) {
        return;
      }
      lastStats = stats;
      if (stats.provider) {
        applyProviderLabel(stats.provider);
      }
      let mode = stats.provider || 'deepseek';
      if (stats.provider === 'free') {
        mode = 'free' + (stats.free_provider ? ':' + stats.free_provider : '') + ' \u00b7 no memory';
      }
      const parts = [
        mode,
        'in ' + fmtTokens(stats.prompt_tokens),
        'out ' + fmtTokens(stats.completion_tokens),
        'cache ' + fmtTokens(stats.cache_hit_tokens),
        fmtCost(stats.cost_usd),
        (stats.requests || 0) + ' req',
        stats.peak ? 'peak' : 'off-peak',
      ];
      if (statsEl) {
        statsEl.textContent = parts.join('  \u00b7  ');
        const prices = stats.prices_per_m || {};
        statsEl.title =
          'model ' +
          stats.model +
          '\nin ' +
          stats.prompt_tokens +
          ' (cache hit ' +
          stats.cache_hit_tokens +
          ', miss ' +
          stats.cache_miss_tokens +
          ')' +
          '\nout ' +
          stats.completion_tokens +
          '\nprice per 1M: hit $' +
          prices.cache_hit +
          ', miss $' +
          prices.cache_miss +
          ', out $' +
          prices.output;
      }
      if (tokensPanel && tokensPanel.classList.contains('open')) {
        renderTokensPanel();
      }
      if (contextPanel && contextPanel.classList.contains('open')) {
        renderContextPanel();
      }
    }

    function statCard(label, value, hint) {
      const card = el('div', 'stat-card');
      card.appendChild(el('span', 'stat-label', label));
      card.appendChild(el('span', 'stat-value', value));
      if (hint) {
        card.appendChild(el('span', 'stat-hint', hint));
      }
      return card;
    }

    function bar(label, percent, tone) {
      const wrap = el('div', 'bar-row');
      const head = el('div', 'bar-head');
      head.appendChild(el('span', 'bar-label', label));
      head.appendChild(el('span', 'bar-value', Math.round(percent) + '%'));
      const track = el('div', 'bar-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', label);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(percent)));
      const fill = el('div', 'bar-fill' + (tone ? ' ' + tone : ''));
      fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
      track.appendChild(fill);
      wrap.appendChild(head);
      wrap.appendChild(track);
      return wrap;
    }

    function renderTokensPanel() {
      if (!tokensContent) {
        return;
      }
      tokensContent.textContent = '';
      if (!lastStats) {
        tokensContent.appendChild(el('p', 'panel-empty', 'No requests yet. Start chatting to see token usage.'));
        return;
      }
      const stats = lastStats;
      const prompt = Number(stats.prompt_tokens) || 0;
      const completion = Number(stats.completion_tokens) || 0;
      const cache = Number(stats.cache_hit_tokens) || 0;
      const miss = Number(stats.cache_miss_tokens) || 0;
      const total = prompt + completion;
      const lastPrompt =
        stats.last_prompt_tokens === undefined || stats.last_prompt_tokens === null
          ? 0
          : Number(stats.last_prompt_tokens);
      const lastCompletion =
        stats.last_completion_tokens === undefined || stats.last_completion_tokens === null
          ? 0
          : Number(stats.last_completion_tokens);
      const lastTotal =
        stats.last_total_tokens === undefined || stats.last_total_tokens === null
          ? lastPrompt + lastCompletion
          : Number(stats.last_total_tokens);

      const grid = el('div', 'stat-grid');
      grid.appendChild(statCard('Input', fmtTokens(prompt), 'prompt tokens'));
      grid.appendChild(statCard('Output', fmtTokens(completion), 'completion tokens'));
      grid.appendChild(statCard('Cache hit', fmtTokens(cache), 'cached input'));
      grid.appendChild(statCard('Cost', fmtCost(stats.cost_usd), 'estimated USD'));
      grid.appendChild(statCard('Requests', String(stats.requests || 0), stats.peak ? 'peak' : 'off-peak'));
      grid.appendChild(
        statCard(
          'Last request',
          fmtTokens(lastPrompt) + ' / ' + fmtTokens(lastCompletion),
          'in / out \u00b7 total ' + fmtTokens(lastTotal)
        )
      );
      tokensContent.appendChild(grid);

      const bars = el('div', 'bars');
      bars.appendChild(
        bar('Input vs output', total > 0 ? (prompt / total) * 100 : 0, 'accent')
      );
      bars.appendChild(
        bar('Cache hit rate', prompt > 0 ? (cache / (cache + miss || prompt)) * 100 : 0, 'blue')
      );
      tokensContent.appendChild(bars);

      const meta = el('div', 'panel-meta');
      meta.appendChild(el('span', 'meta-label', 'Model'));
      meta.appendChild(el('span', 'meta-value', String(stats.model || 'unknown')));
      meta.appendChild(el('span', 'meta-label', 'Provider'));
      meta.appendChild(el('span', 'meta-value', String(stats.provider || 'unknown')));
      tokensContent.appendChild(meta);

      const note = el(
        'p',
        'panel-note',
        'Cumulative across chat and inline requests for this backend process.'
      );
      tokensContent.appendChild(note);
    }

    function renderContextPanel() {
      if (!contextContent) {
        return;
      }
      contextContent.textContent = '';
      const chat = activeChat();
      const stats = lastStats || {};
      const limit = Number(stats.context_limit) || DEFAULT_CONTEXT_LIMIT;
      const rawUsed =
        stats.last_prompt_tokens === undefined || stats.last_prompt_tokens === null
          ? Number(stats.prompt_tokens) || 0
          : Number(stats.last_prompt_tokens) || 0;
      const used = Math.min(rawUsed, limit);
      const percent = limit > 0 ? (used / limit) * 100 : 0;
      let chars = 0;
      for (const message of chat.messages) {
        chars += String(message.content || '').length;
        chars += String(message.reasoning || '').length;
      }

      const grid = el('div', 'stat-grid');
      grid.appendChild(
        statCard(
          'Prompt tokens',
          fmtTokens(rawUsed) + ' / ' + fmtTokens(limit),
          'last request vs CONTEXT_LIMIT'
        )
      );
      grid.appendChild(
        statCard('Used', percent.toFixed(1) + '%', 'of the context window')
      );
      grid.appendChild(statCard('Messages', String(chat.messages.length), 'in this chat'));
      grid.appendChild(statCard('Characters', fmtCount(chars), 'chat text + reasoning'));
      contextContent.appendChild(grid);

      const bars = el('div', 'bars');
      bars.appendChild(bar('Context used', percent, percent > 85 ? 'danger' : 'accent'));
      contextContent.appendChild(bars);

      const meta = el('div', 'panel-meta');
      meta.appendChild(el('span', 'meta-label', 'Provider'));
      meta.appendChild(el('span', 'meta-value', String(stats.provider || chat.provider || 'unknown')));
      meta.appendChild(el('span', 'meta-label', 'Model'));
      meta.appendChild(el('span', 'meta-value', String(stats.model || 'unknown')));
      contextContent.appendChild(meta);
      contextContent.appendChild(
        el(
          'p',
          'panel-note',
          'The limit is configurable with CONTEXT_LIMIT in the backend environment.'
        )
      );
    }

    function titleFor(text) {
      const clean = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) {
        return 'New chat';
      }
      return clean.length > 48 ? clean.slice(0, 48).trimEnd() + '\u2026' : clean;
    }

    function relTime(timestamp) {
      const delta = Date.now() - (Number(timestamp) || Date.now());
      if (delta < 60000) {
        return 'just now';
      }
      if (delta < 3600000) {
        return Math.floor(delta / 60000) + 'm';
      }
      if (delta < 86400000) {
        return Math.floor(delta / 3600000) + 'h';
      }
      if (delta < 604800000) {
        return Math.floor(delta / 86400000) + 'd';
      }
      try {
        return new Date(timestamp).toLocaleDateString();
      } catch (_) {
        return '';
      }
    }

    function previewFor(chat) {
      for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
        const message = chat.messages[i];
        const text = String(message.content || '').replace(/\s+/g, ' ').trim();
        if (text) {
          return text.length > 72 ? text.slice(0, 72).trimEnd() + '\u2026' : text;
        }
      }
      return 'No messages yet';
    }

    function addActions(container, message, index) {
      const row = el('div', 'msg-actions');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Message actions');

      const copy = iconButton('copy', 'Copy message', 'action-btn');
      if (!message.content) {
        copy.disabled = true;
      }
      copy.addEventListener('click', function () {
        if (message.content) {
          vscode.postMessage({ type: 'copyText', text: message.content });
        }
      });
      row.appendChild(copy);

      if (message.role === 'assistant' && message.content) {
        const insert = iconButton('check', 'Insert answer at cursor', 'action-btn');
        insert.addEventListener('click', function () {
          vscode.postMessage({ type: 'insert', text: message.content });
        });
        row.appendChild(insert);
      }

      if (message.role === 'user') {
        const edit = iconButton('edit', 'Edit message', 'action-btn');
        edit.addEventListener('click', function () {
          if (stream) {
            toast('Stop the current response first');
            return;
          }
          inputEl.value = message.content;
          autoGrow();
          updateComposer();
          inputEl.focus();
          try {
            inputEl.setSelectionRange(message.content.length, message.content.length);
          } catch (_) {
            // ignore
          }
        });
        recordSafeIndex(edit, message, index);
        row.appendChild(edit);

        const remove = iconButton('trash', 'Delete message', 'action-btn danger');
        remove.addEventListener('click', function () {
          confirmAction('Delete this message?', 'Delete', function () {
            if (stream) {
              toast('Stop the current response first');
              return;
            }
            const chat = activeChat();
            const at = chat.messages.indexOf(message);
            if (at >= 0) {
              chat.messages.splice(at, 1);
              chat.updatedAt = Date.now();
              persist();
              renderMessages();
              updateEmpty();
              renderContextPanel();
              toast('Message deleted');
            }
          });
        });
        row.appendChild(remove);
      }

      container.appendChild(row);
    }

    function recordSafeIndex(button, message, index) {
      button.setAttribute('data-index', String(index));
      button.setAttribute('data-role', message.role);
    }

    function renderMessage(message, index) {
      if (message.role === 'assistant') {
        if (message.reasoning) {
          appendReasoningStatic(message.reasoning);
        }
        const bubble = el('div', 'msg assistant markdown');
        bubble.setAttribute('data-role', 'assistant');
        if (message.content) {
          renderMarkdown(bubble, message.content, true);
          addActions(bubble, message, index);
          messagesEl.appendChild(bubble);
        }
        return;
      }
      if (message.role === 'user') {
        const bubble = el('div', 'msg user');
        bubble.setAttribute('data-role', 'user');
        bubble.appendChild(el('div', 'msg-body', message.content));
        addActions(bubble, message, index);
        messagesEl.appendChild(bubble);
        return;
      }
      const bubble = el('div', 'msg error');
      bubble.setAttribute('role', 'alert');
      bubble.appendChild(iconSpan('close', 'error-icon'));
      bubble.appendChild(el('div', 'msg-body', message.content));
      addActions(bubble, message, index);
      messagesEl.appendChild(bubble);
    }

    function renderMessages() {
      if (!messagesEl) {
        return;
      }
      messagesEl.textContent = '';
      const chat = activeChat();
      for (let i = 0; i < chat.messages.length; i += 1) {
        renderMessage(chat.messages[i], i);
      }
      scrollToBottom();
    }

    function updateEmpty() {
      if (!emptyEl) {
        return;
      }
      const chat = activeChat();
      const show = chat.messages.length === 0 && !stream;
      emptyEl.hidden = !show;
      emptyEl.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    function renderChatTitle() {
      const chat = activeChat();
      if (chatTitleEl) {
        chatTitleEl.textContent = chat.title;
        chatTitleEl.title = chat.title;
      }
    }

    function renderSelectors() {
      const chat = activeChat();
      if (providerSelect) {
        providerSelect.value = chat.provider;
      }
      if (reasoningSelect) {
        reasoningSelect.value = chat.reasoningEffort;
      }
      applyProviderLabel(chat.provider);
    }

    function chatItem(chat) {
      const item = el('div', 'chat-item' + (chat.id === state.activeId ? ' active' : ''));
      item.setAttribute('data-chat-id', chat.id);
      if (chat.id === state.activeId) {
        item.setAttribute('aria-current', 'true');
      }

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chat-item-main';
      main.appendChild(el('span', 'chat-title', chat.title));
      main.appendChild(el('span', 'chat-preview', previewFor(chat)));
      main.appendChild(el('span', 'chat-time', relTime(chat.updatedAt)));
      main.addEventListener('click', function () {
        switchChat(chat.id);
      });
      item.appendChild(main);

      const actions = el('div', 'chat-item-actions');
      const rename = iconButton('edit', 'Rename chat', 'action-btn');
      rename.addEventListener('click', function (event) {
        event.stopPropagation();
        startRename(item, chat);
      });
      actions.appendChild(rename);

      const remove = iconButton('trash', 'Delete chat', 'action-btn danger');
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        if (stream) {
          toast('Stop the current response first');
          return;
        }
        confirmAction('Delete "' + chat.title + '"? This cannot be undone.', 'Delete', function () {
          deleteChat(chat.id);
        });
      });
      actions.appendChild(remove);
      item.appendChild(actions);
      return item;
    }

    function renderChatList() {
      if (!chatsList) {
        return;
      }
      chatsList.textContent = '';
      const chats = state.chats.slice().sort(function (a, b) {
        return b.updatedAt - a.updatedAt;
      });
      for (const chat of chats) {
        chatsList.appendChild(chatItem(chat));
      }
    }

    function startRename(item, chat) {
      const main = item.querySelector('.chat-item-main');
      if (!main) {
        return;
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'chat-rename-input';
      input.value = chat.title;
      input.setAttribute('aria-label', 'Chat name');
      main.replaceWith(input);
      input.focus();
      input.select();
      let done = false;

      function commit(save) {
        if (done) {
          return;
        }
        done = true;
        if (save) {
          const value = input.value.trim();
          if (value) {
            chat.title = value.slice(0, 80);
            chat.manualTitle = true;
            chat.updatedAt = Date.now();
            persist();
            toast('Renamed');
          }
        }
        renderChatList();
        renderChatTitle();
      }

      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          commit(false);
        }
      });
      input.addEventListener('blur', function () {
        commit(true);
      });
    }

    function deleteChat(id) {
      if (stream) {
        toast('Stop the current response first');
        return;
      }
      state.chats = state.chats.filter(function (chat) {
        return chat.id !== id;
      });
      if (!state.chats.length) {
        const chat = makeChat();
        state.chats.push(chat);
        state.activeId = chat.id;
      } else if (state.activeId === id) {
        state.activeId = state.chats[0].id;
      }
      persist();
      renderAll();
      toast('Chat deleted');
    }

    function switchChat(id) {
      if (id === state.activeId) {
        closeDrawer();
        return;
      }
      if (stream) {
        toast('Stop the current response first');
        return;
      }
      if (!findChat(id)) {
        return;
      }
      state.activeId = id;
      persist();
      renderAll();
      closeDrawer();
      if (inputEl) {
        inputEl.focus();
      }
    }

    function newChat() {
      if (stream) {
        toast('Stop the current response first');
        return;
      }
      const chat = makeChat();
      state.chats.push(chat);
      state.activeId = chat.id;
      persist();
      renderAll();
      closeDrawer();
      if (inputEl) {
        inputEl.value = '';
        autoGrow();
        updateComposer();
        inputEl.focus();
      }
    }

    function renderAll() {
      renderSelectors();
      renderChatTitle();
      renderMessages();
      updateEmpty();
      renderChatList();
      renderContextPanel();
    }

    function beginStream(chat) {
      const typing = el('div', 'msg assistant typing');
      typing.setAttribute('aria-label', 'Assistant is typing');
      for (let i = 0; i < 3; i += 1) {
        typing.appendChild(el('span', 'dot'));
      }
      messagesEl.appendChild(typing);
      stream = {
        chatId: chat.id,
        el: typing,
        current: '',
        reasoningText: '',
        reasoningChars: 0,
        reasoningBlock: null,
        reasoningSummary: null,
        reasoningLabel: null,
        reasoningBody: null,
        changedFiles: [],
        stopTimer: null,
      };
      setStatus('Thinking...');
      updateEmpty();
      updateComposer();
      scrollToBottom();
    }

    function ensureLiveAssistant() {
      if (!stream) {
        beginStream(activeChat());
      }
      if (stream.el && stream.el.classList.contains('typing')) {
        stream.el.classList.remove('typing');
        stream.el.textContent = '';
        stream.el.classList.add('markdown');
      }
      return stream.el;
    }

    function extractFileBlocks(text) {
      const lines = String(text || '').split('\n');
      const files = [];
      let index = 0;
      while (index < lines.length && files.length < 20) {
        const trimmed = lines[index].trim();
        if (!/^```/.test(trimmed)) {
          index += 1;
          continue;
        }
        const rest = trimmed.slice(3).trim();
        const match = rest.match(/file=(?:"([^"]+)"|'([^']+)'|(\S+))/);
        const filePath = match ? match[1] || match[2] || match[3] : '';
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index].trim())) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        if (filePath) {
          files.push({ path: filePath, content: codeLines.join('\n') });
        }
      }
      return files;
    }

    function autoApplyFromMessage(message) {
      if (!autoApplyFiles || !message || message.autoApplied || !message.content) {
        return;
      }
      const files = extractFileBlocks(message.content);
      message.autoApplied = true;
      persist();
      if (files.length) {
        vscode.postMessage({ type: 'applyFiles', files: files });
      }
    }

    function finalizeStream(options) {
      if (!stream) {
        return;
      }
      const current = stream;
      stream = null;
      if (current.stopTimer) {
        clearTimeout(current.stopTimer);
      }
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      if (current.reasoningLabel) {
        current.reasoningLabel.textContent =
          'Reasoning \u00b7 ' + current.reasoningChars + ' chars';
      }
      if (current.el) {
        if (current.current) {
          current.el.classList.remove('typing');
          current.el.classList.add('markdown');
          current.el.textContent = '';
          renderMarkdown(current.el, current.current, true);
        }
        if (!current.current) {
          current.el.remove();
        }
      }

      const chat = findChat(current.chatId);
      if (chat && (current.current || current.reasoningText)) {
        const message = { role: 'assistant', content: current.current };
        if (current.reasoningText) {
          message.reasoning = current.reasoningText;
        }
        chat.messages.push(message);
        chat.updatedAt = Date.now();
        if (current.el && current.current) {
          addActions(current.el, message, chat.messages.length - 1);
        }
        if (current.changedFiles.length) {
          showChangedFiles(current.changedFiles);
        }
        persist();
        if (!options || (!options.stopped && !options.error)) {
          autoApplyFromMessage(message);
        }
      }
      setStatus('');
      setStreamingUi(false);
      updateEmpty();
      renderChatList();
      renderContextPanel();
      updateComposer();
      if (options && options.stopped) {
        toast('Stopped');
      }
    }

    function stopStream() {
      if (!stream) {
        return;
      }
      vscode.postMessage({ type: 'stopChat' });
      setStatus('Stopping...');
      const target = stream;
      target.stopTimer = setTimeout(function () {
        if (stream === target) {
          finalizeStream({ stopped: true });
        }
      }, 1800);
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text || stream) {
        return;
      }
      const chat = activeChat();
      const prior = chat.messages
        .filter(function (message) {
          return message.role === 'user' || message.role === 'assistant';
        })
        .map(function (message) {
          return { role: message.role, content: message.content };
        });
      const firstUser = !chat.messages.some(function (message) {
        return message.role === 'user';
      });
      const userMessage = { role: 'user', content: text };
      chat.messages.push(userMessage);
      if (firstUser && !chat.manualTitle && (chat.title === 'New chat' || !chat.title)) {
        chat.title = titleFor(text);
      }
      chat.updatedAt = Date.now();
      inputEl.value = '';
      autoGrow();
      renderMessages();
      beginStream(chat);
      renderChatTitle();
      renderChatList();
      persist();
      updateComposer();

      vscode.postMessage({
        type: 'send',
        text: text,
        history: prior,
        provider: chat.provider,
        reasoningEffort: chat.reasoningEffort,
        attachments: attachments.map(function (attachment) {
          return { path: attachment.path, content: attachment.content };
        }),
      });
      attachments = [];
      renderAttachments();
    }

    function autoGrow() {
      if (!inputEl) {
        return;
      }
      inputEl.style.height = 'auto';
      const next = Math.min(inputEl.scrollHeight || 0, 180);
      inputEl.style.height = (next > 0 ? next : 44) + 'px';
    }

    function updateComposer() {
      if (!sendBtn) {
        return;
      }
      const busy = Boolean(stream);
      const hasText = Boolean(inputEl && inputEl.value.trim());
      sendBtn.disabled = busy || !hasText;
      sendBtn.hidden = busy;
      if (stopBtn) {
        stopBtn.disabled = !busy;
        stopBtn.hidden = !busy;
      }
    }

    function setStreamingUi(busy) {
      if (stopBtn) {
        stopBtn.disabled = !busy;
        stopBtn.hidden = !busy;
      }
      if (sendBtn) {
        sendBtn.hidden = busy;
      }
      updateComposer();
    }

    function toast(text, kind) {
      if (!toastsEl || !text) {
        return;
      }
      toastSeq += 1;
      const node = el('div', 'toast' + (kind ? ' ' + kind : ''), text);
      node.setAttribute('data-toast', String(toastSeq));
      toastsEl.appendChild(node);
      setTimeout(function () {
        node.classList.add('toast-out');
        setTimeout(function () {
          if (node.parentNode) {
            node.parentNode.removeChild(node);
          }
        }, 220);
      }, 2200);
    }

    function confirmAction(message, confirmLabel, callback) {
      if (!confirmEl) {
        if (typeof window.confirm === 'function' && window.confirm(message)) {
          callback();
        }
        return;
      }
      confirmText.textContent = message;
      confirmOk.textContent = confirmLabel || 'Delete';
      confirmCallback = callback;
      confirmEl.hidden = false;
      confirmCancel.focus();
    }

    function closeConfirm() {
      if (!confirmEl) {
        return;
      }
      confirmEl.hidden = true;
      confirmCallback = null;
    }

    function updateScrim() {
      if (!scrimEl) {
        return;
      }
      const drawerOpen = chatDrawer && chatDrawer.classList.contains('open');
      const panelOpen =
        (tokensPanel && tokensPanel.classList.contains('open')) ||
        (contextPanel && contextPanel.classList.contains('open'));
      scrimEl.hidden = !(drawerOpen || panelOpen);
    }

    function closePanels() {
      if (tokensPanel) {
        tokensPanel.classList.remove('open');
        tokensPanel.setAttribute('aria-hidden', 'true');
      }
      if (contextPanel) {
        contextPanel.classList.remove('open');
        contextPanel.setAttribute('aria-hidden', 'true');
      }
      if (tokensBtn) {
        tokensBtn.setAttribute('aria-expanded', 'false');
      }
      if (contextBtn) {
        contextBtn.setAttribute('aria-expanded', 'false');
      }
      updateScrim();
    }

    function openDrawer() {
      closePanels();
      if (!chatDrawer) {
        return;
      }
      renderChatList();
      chatDrawer.classList.add('open');
      chatDrawer.setAttribute('aria-hidden', 'false');
      if (chatsToggle) {
        chatsToggle.setAttribute('aria-expanded', 'true');
      }
      updateScrim();
      if (chatDrawerClose) {
        chatDrawerClose.focus();
      }
    }

    function closeDrawer() {
      if (chatDrawer) {
        chatDrawer.classList.remove('open');
        chatDrawer.setAttribute('aria-hidden', 'true');
      }
      if (chatsToggle) {
        chatsToggle.setAttribute('aria-expanded', 'false');
      }
      updateScrim();
    }

    function openPanel(panel, toggle, closeButton, render) {
      if (!panel) {
        return;
      }
      closeDrawer();
      closePanels();
      render();
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'true');
      }
      updateScrim();
      if (closeButton) {
        closeButton.focus();
      }
    }

    function closeAllOverlays() {
      closeDrawer();
      closePanels();
      closeConfirm();
      toggleAttachMenu(false);
    }

    function toggleAttachMenu(open) {
      if (!attachMenu || !attachBtn) {
        return;
      }
      attachMenu.hidden = !open;
      attachBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function renderAttachments() {
      if (!chipsEl) {
        return;
      }
      chipsEl.textContent = '';
      if (!attachments.length) {
        chipsEl.hidden = true;
        return;
      }
      chipsEl.hidden = false;
      attachments.forEach(function (attachment, index) {
        const chip = el('span', 'attachment-chip');
        chip.title = attachment.path;
        chip.appendChild(iconSpan('attach', 'chip-icon'));
        const name = String(attachment.path || 'file').split(/[\\/]/).pop();
        chip.appendChild(el('span', 'chip-name', name));
        const remove = iconButton('close', 'Remove ' + attachment.path, 'chip-remove');
        remove.addEventListener('click', function () {
          attachments.splice(index, 1);
          renderAttachments();
          updateComposer();
        });
        chip.appendChild(remove);
        chipsEl.appendChild(chip);
      });
    }

    function addAttachment(path, content) {
      if (!path || typeof content !== 'string') {
        return;
      }
      let replaced = false;
      for (const attachment of attachments) {
        if (attachment.path === path) {
          attachment.content = content;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        attachments.push({ path: path, content: content });
      }
      renderAttachments();
      updateComposer();
      toast((replaced ? 'Updated ' : 'Attached ') + String(path).split(/[\\/]/).pop());
    }

    chatsToggle && chatsToggle.addEventListener('click', openDrawer);
    chatDrawerClose && chatDrawerClose.addEventListener('click', closeDrawer);
    drawerNewChat && drawerNewChat.addEventListener('click', newChat);
    newChatBtn && newChatBtn.addEventListener('click', newChat);
    settingsBtn &&
      settingsBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openSettings' });
      });
    sendBtn && sendBtn.addEventListener('click', send);
    stopBtn && stopBtn.addEventListener('click', stopStream);
    insertBtnFallback();

    function insertBtnFallback() {
      const legacy = document.getElementById('insert');
      if (legacy && !legacy.__wired) {
        legacy.__wired = true;
        legacy.addEventListener('click', function () {
          const chat = activeChat();
          for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
            const message = chat.messages[i];
            if (message.role === 'assistant' && message.content) {
              vscode.postMessage({ type: 'insert', text: message.content });
              return;
            }
          }
        });
      }
    }

    tokensBtn &&
      tokensBtn.addEventListener('click', function () {
        openPanel(tokensPanel, tokensBtn, tokensClose, renderTokensPanel);
      });
    contextBtn &&
      contextBtn.addEventListener('click', function () {
        openPanel(contextPanel, contextBtn, contextClose, renderContextPanel);
      });
    tokensClose &&
      tokensClose.addEventListener('click', function () {
        closePanels();
        tokensBtn && tokensBtn.focus();
      });
    contextClose &&
      contextClose.addEventListener('click', function () {
        closePanels();
        contextBtn && contextBtn.focus();
      });
    scrimEl && scrimEl.addEventListener('click', closeAllOverlays);
    confirmCancel && confirmCancel.addEventListener('click', closeConfirm);
    confirmOk &&
      confirmOk.addEventListener('click', function () {
        const callback = confirmCallback;
        closeConfirm();
        if (callback) {
          callback();
        }
      });
    confirmEl &&
      confirmEl.addEventListener('click', function (event) {
        if (event.target === confirmEl) {
          closeConfirm();
        }
      });

    attachBtn &&
      attachBtn.addEventListener('click', function () {
        toggleAttachMenu(attachMenu ? attachMenu.hidden : false);
      });
    attachFile &&
      attachFile.addEventListener('click', function () {
        toggleAttachMenu(false);
        vscode.postMessage({ type: 'pickFiles' });
      });
    attachPath &&
      attachPath.addEventListener('click', function () {
        toggleAttachMenu(false);
        vscode.postMessage({ type: 'addPath' });
      });
    document.addEventListener('click', function (event) {
      if (!attachMenu || attachMenu.hidden) {
        return;
      }
      const target = event.target;
      if (
        target !== attachBtn &&
        !attachMenu.contains(target) &&
        !(attachBtn && attachBtn.contains(target))
      ) {
        toggleAttachMenu(false);
      }
    });

    if (inputEl) {
      inputEl.addEventListener('input', function () {
        autoGrow();
        updateComposer();
      });
      inputEl.addEventListener('keydown', function (event) {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          send();
        }
      });
    }

    if (reasoningSelect) {
      reasoningSelect.addEventListener('change', function () {
        const chat = activeChat();
        chat.reasoningEffort = safeEffort(reasoningSelect.value);
        chat.updatedAt = Date.now();
        lastSettings.reasoningEffort = chat.reasoningEffort;
        persist();
        vscode.postMessage({ type: 'setReasoning', value: chat.reasoningEffort });
      });
    }
    if (providerSelect) {
      providerSelect.addEventListener('change', function () {
        const chat = activeChat();
        chat.provider = safeProvider(providerSelect.value);
        chat.updatedAt = Date.now();
        lastSettings.provider = chat.provider;
        persist();
        applyProviderLabel(chat.provider);
        vscode.postMessage({ type: 'setProvider', value: chat.provider });
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') {
        return;
      }
      if (confirmEl && !confirmEl.hidden) {
        closeConfirm();
        return;
      }
      if (attachMenu && !attachMenu.hidden) {
        toggleAttachMenu(false);
        return;
      }
      closeAllOverlays();
    });

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message) {
        return;
      }
      switch (message.type) {
        case 'reasoning':
          appendReasoning(message.delta || '');
          setStatus('Thinking...');
          break;
        case 'reasoning_end':
          endReasoning();
          break;
        case 'diff':
          addDiff(message);
          break;
        case 'link':
          addLink(message.text, message.url);
          break;
        case 'appliedFile':
          addAppliedFile(message.path);
          toast('Saved ' + (message.path || 'file'));
          break;
        case 'delta': {
          const target = ensureLiveAssistant();
          if (target) {
            stream.current += message.text || '';
            scheduleRender();
          }
          setStatus('');
          break;
        }
        case 'status':
        case 'tool_result':
          setStatus(message.text);
          break;
        case 'stats':
          renderStats(message.stats);
          break;
        case 'settings':
          lastSettings = {
            provider: safeProvider(message.provider),
            reasoningEffort: safeEffort(message.reasoningEffort),
          };
          autoApplyFiles = message.autoApplyFiles !== false;
          {
            const chat = activeChat();
            if (!chat.messages.length && !chat.manualTitle && chat.title === 'New chat') {
              chat.provider = lastSettings.provider;
              chat.reasoningEffort = lastSettings.reasoningEffort;
              persist();
            }
          }
          renderSelectors();
          if (!stream) {
            renderMessages();
            updateEmpty();
          }
          break;
        case 'error': {
          const text = message.text || 'Unknown error';
          if (stream) {
            finalizeStream({ error: true });
          }
          const chat = activeChat();
          chat.messages.push({ role: 'error', content: text });
          chat.updatedAt = Date.now();
          persist();
          renderMessages();
          updateEmpty();
          renderChatList();
          setStatus('');
          break;
        }
        case 'stopped':
          if (stream) {
            finalizeStream({ stopped: true });
          }
          setStatus('');
          break;
        case 'done':
          if (message.stats) {
            renderStats(message.stats);
          }
          if (stream) {
            finalizeStream({});
          } else {
            setStatus('');
            if (pendingFiles.length) {
              showChangedFiles(pendingFiles);
              pendingFiles = [];
            }
          }
          break;
        case 'appliedFiles': {
          const paths = Array.isArray(message.paths) ? message.paths : [];
          if (paths.length) {
            addAppliedFiles(paths);
            toast(
              (message.overwrote && message.overwrote.length
                ? 'Updated '
                : 'Created ') + paths.length + ' file(s)'
            );
          }
          if (Array.isArray(message.errors) && message.errors.length) {
            toast(String(message.errors[0]), 'error');
          }
          break;
        }
        case 'attachment':
          addAttachment(String(message.path || ''), String(message.content || ''));
          break;
        case 'attachmentError':
          toast(message.text || 'Could not attach file', 'error');
          break;
        case 'copied':
          toast('Copied');
          break;
        case 'toast':
          toast(message.text || '');
          break;
        case 'preset':
          if (inputEl) {
            inputEl.value = message.text || '';
            autoGrow();
            updateComposer();
            send();
          }
          break;
      }
    });

    loadState();
    renderAll();
    renderAttachments();
    updateComposer();
    autoGrow();

    if (hasVsCodeApi) {
      vscode.postMessage({ type: 'ready' });
    } else {
      setStatus('Webview API is unavailable in this host.');
      const chat = activeChat();
      chat.messages.push({
        role: 'error',
        content: 'This webview host does not provide acquireVsCodeApi().',
      });
      renderMessages();
      updateEmpty();
    }
  } catch (err) {
    showFatal(err);
  }
})();
