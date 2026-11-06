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
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const statusEl = document.getElementById('status');
    const sendBtn = document.getElementById('send');
    const insertBtn = document.getElementById('insert');
    const statsEl = document.getElementById('stats');
    const reasoningSelect = document.getElementById('reasoning');

    const history = [];
    let current = '';
    let streamingEl = null;
    let lastAssistant = '';
    let reasoningBlock = null;
    let reasoningBodyEl = null;
    let reasoningSummaryEl = null;
    let reasoningChars = 0;
    let renderTimer = null;
    let changedFiles = [];

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

    function addMessage(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return el;
    }

    function setStatus(text) {
      statusEl.textContent = text || '';
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

    function renderMarkdown(container, text) {
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
          code.textContent = codeLines.join('\n');
          pre.appendChild(code);
          container.appendChild(pre);
          continue;
        }

        const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          closeList();
          const el = document.createElement('div');
          el.className = 'md-h md-h' + heading[1].length;
          renderInline(el, heading[2]);
          container.appendChild(el);
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
            listEl = document.createElement('div');
            listEl.className = 'md-list';
            container.appendChild(listEl);
          }
          const row = document.createElement('div');
          row.className = 'md-item';
          const bullet = document.createElement('span');
          bullet.className = 'md-bullet';
          bullet.textContent = /^\d+\.$/.test(item[1]) ? item[1] : '•';
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
          const el = document.createElement('div');
          el.className = 'md-quote';
          renderInline(el, quote[1]);
          container.appendChild(el);
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
        const p = document.createElement('div');
        p.className = 'md-p';
        renderInline(p, paragraph);
        container.appendChild(p);
      }
    }

    function scheduleRender() {
      if (renderTimer) {
        return;
      }
      renderTimer = setTimeout(function () {
        renderTimer = null;
        if (streamingEl) {
          renderMarkdown(streamingEl, current);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }, 60);
    }

    function endReasoning() {
      if (reasoningSummaryEl) {
        reasoningSummaryEl.textContent = 'Reasoning · ' + reasoningChars + ' chars';
      }
      reasoningBlock = null;
      reasoningBodyEl = null;
      reasoningSummaryEl = null;
      reasoningChars = 0;
    }

    function appendReasoning(text) {
      if (!reasoningBlock) {
        reasoningBlock = document.createElement('details');
        reasoningBlock.className = 'reasoning';
        reasoningSummaryEl = document.createElement('summary');
        reasoningSummaryEl.textContent = 'Reasoning';
        reasoningBodyEl = document.createElement('div');
        reasoningBodyEl.className = 'reasoning-body';
        reasoningBlock.appendChild(reasoningSummaryEl);
        reasoningBlock.appendChild(reasoningBodyEl);
        messagesEl.appendChild(reasoningBlock);
        reasoningChars = 0;
      }
      reasoningChars += text.length;
      reasoningSummaryEl.textContent = 'Reasoning · ' + reasoningChars + ' chars';
      reasoningBodyEl.textContent += text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addDiff(info) {
      if (!info || !info.diff) {
        return;
      }
      if (info.path && !changedFiles.some(function (file) { return file.path === info.path; })) {
        changedFiles.push({ path: info.path, absPath: info.abs_path || null });
      }

      const details = document.createElement('details');
      details.className = 'edit';
      details.open = true;

      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'edit-label';
      label.textContent = info.created ? 'New file' : 'Edit file';
      const pathEl = document.createElement('span');
      pathEl.className = 'edit-path';
      pathEl.appendChild(fileLink(info.path || 'file', info.abs_path));
      const counts = document.createElement('span');
      counts.className = 'edit-counts';
      counts.textContent = '+' + (info.added || 0) + ' -' + (info.removed || 0);
      summary.appendChild(label);
      summary.appendChild(pathEl);
      summary.appendChild(counts);
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'diff-body';
      const lines = String(info.diff).split('\n');
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = 'diff-line';
        if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) {
          row.classList.add('meta');
        } else if (line.charAt(0) === '+') {
          row.classList.add('add');
        } else if (line.charAt(0) === '-') {
          row.classList.add('del');
        } else if (line.indexOf('@@') === 0) {
          row.classList.add('hunk');
        }
        row.textContent = line || ' ';
        body.appendChild(row);
      }
      details.appendChild(body);
      messagesEl.appendChild(details);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showChangedFiles() {
      if (!changedFiles.length) {
        return;
      }
      const box = document.createElement('div');
      box.className = 'files';
      const label = document.createElement('div');
      label.className = 'files-label';
      label.textContent = 'Files';
      const list = document.createElement('div');
      list.className = 'files-list';
      for (const file of changedFiles) {
        const chip = document.createElement('span');
        chip.className = 'file-chip';
        chip.appendChild(fileLink(file.path, file.absPath));
        list.appendChild(chip);
      }
      box.appendChild(label);
      box.appendChild(list);
      messagesEl.appendChild(box);
      messagesEl.scrollTop = messagesEl.scrollHeight;
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
      if (!stats || !statsEl) {
        return;
      }
      const parts = [
        'in ' + fmtTokens(stats.prompt_tokens),
        'out ' + fmtTokens(stats.completion_tokens),
        'cache ' + fmtTokens(stats.cache_hit_tokens),
        fmtCost(stats.cost_usd),
        (stats.requests || 0) + ' req',
        stats.peak ? 'peak' : 'off-peak'
      ];
      statsEl.textContent = parts.join('  ·  ');
      const prices = stats.prices_per_m || {};
      statsEl.title =
        'model ' + stats.model +
        '\nin ' + stats.prompt_tokens +
        ' (cache hit ' + stats.cache_hit_tokens + ', miss ' + stats.cache_miss_tokens + ')' +
        '\nout ' + stats.completion_tokens +
        '\nprice per 1M: hit $' + prices.cache_hit + ', miss $' + prices.cache_miss + ', out $' + prices.output +
        '\n(peak 01-04, 06-10 UTC, Mon-Fri)';
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) {
        return;
      }
      inputEl.value = '';
      endReasoning();
      changedFiles = [];
      addMessage('user', text);
      const prior = history.slice();
      history.push({ role: 'user', content: text });
      current = '';
      streamingEl = null;
      lastAssistant = '';
      setStatus('Thinking...');
      vscode.postMessage({ type: 'send', text: text, history: prior });
    }

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
        case 'delta':
          if (!streamingEl) {
            streamingEl = addMessage('assistant', '');
            streamingEl.classList.add('markdown');
          }
          current += message.text;
          scheduleRender();
          setStatus('');
          break;
        case 'status':
        case 'tool_result':
          setStatus(message.text);
          break;
        case 'stats':
          renderStats(message.stats);
          break;
        case 'settings':
          if (reasoningSelect) {
            reasoningSelect.value = message.reasoningEffort || 'medium';
          }
          break;
        case 'error':
          addMessage('error', message.text || 'Unknown error');
          setStatus('');
          break;
        case 'done':
          if (renderTimer) {
            clearTimeout(renderTimer);
            renderTimer = null;
          }
          if (streamingEl) {
            renderMarkdown(streamingEl, current);
          }
          endReasoning();
          if (current) {
            history.push({ role: 'assistant', content: current });
            lastAssistant = current;
          }
          current = '';
          streamingEl = null;
          setStatus('');
          showChangedFiles();
          changedFiles = [];
          break;
        case 'preset':
          inputEl.value = message.text || '';
          send();
          break;
      }
    });

    sendBtn.addEventListener('click', send);
    insertBtn.addEventListener('click', function () {
      if (lastAssistant) {
        vscode.postMessage({ type: 'insert', text: lastAssistant });
      }
    });
    inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    if (reasoningSelect) {
      reasoningSelect.addEventListener('change', function () {
        vscode.postMessage({ type: 'setReasoning', value: reasoningSelect.value });
      });
    }

    vscode.postMessage({ type: 'ready' });
  } catch (err) {
    showFatal(err);
  }
})();
