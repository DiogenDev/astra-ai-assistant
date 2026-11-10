const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'media', 'chat.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<div id="topbar">
  <button id="chats-toggle" aria-expanded="false"></button>
  <span id="brand">GPT 6 Astra</span>
  <span id="chat-title">New chat</span>
  <button id="tokens-btn" aria-expanded="false"></button>
  <button id="context-btn" aria-expanded="false"></button>
  <button id="settings-btn"></button>
  <button id="newchat"></button>
  <select id="provider">
    <option value="auto">Auto</option>
    <option value="deepseek">GPT 6 Astra</option>
    <option value="free">GPT 5.6 Terra</option>
  </select>
  <select id="reasoning">
    <option value="auto">auto</option><option value="none">none</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
  </select>
  <span id="stats">no requests yet</span>
</div>
<main><div id="empty" hidden></div><div id="messages"></div></main>
<div id="status"></div>
<footer id="composer">
  <div id="attachment-chips" hidden></div>
  <button id="attach" aria-expanded="false"></button>
  <div id="attach-menu" hidden><button id="attach-file"></button><button id="attach-path"></button></div>
  <textarea id="input"></textarea>
  <button id="stop" hidden disabled></button>
  <button id="send"></button>
</footer>
<div id="scrim" hidden></div>
<aside id="chat-drawer" aria-hidden="true"><button id="chat-drawer-close"></button><button id="drawer-newchat"></button><div id="chats-list"></div></aside>
<aside id="tokens-panel" aria-hidden="true"><button id="tokens-close"></button><div id="tokens-content"></div></aside>
<aside id="context-panel" aria-hidden="true"><button id="context-close"></button><div id="context-content"></div></aside>
<div id="confirm" hidden><h2 id="confirm-text"></h2><button id="confirm-cancel"></button><button id="confirm-ok"></button></div>
<div id="toasts"></div>
</body></html>`;

function createWebview(initialState) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const posted = [];
  let state = initialState;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (message) => posted.push(message),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  });
  dom.window.eval(CHAT_JS);
  const send = (data) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { dom, window: dom.window, doc: dom.window.document, posted, send, getState: () => state };
}

const tick = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));

function click(doc, element) {
  element.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function findButtonByTitle(doc, title) {
  return Array.from(doc.querySelectorAll('[title]')).find(
    (element) => element.getAttribute('title') === title
  );
}

test('posts ready on load', () => {
  const { posted } = createWebview();
  assert.ok(posted.some((message) => message.type === 'ready'));
});

test('renders markdown, lists and clickable file paths', async () => {
  const { doc, posted, send } = createWebview();
  send({
    type: 'delta',
    text: '**bold** `snake.py`\n\n```\npython snake.py\n```\n\n- one\n- two',
  });
  await tick();

  assert.equal(doc.querySelectorAll('.msg.assistant strong').length, 1);
  assert.equal(doc.querySelector('.msg.assistant pre code').textContent, 'python snake.py');
  assert.equal(doc.querySelectorAll('.msg.assistant .md-item').length, 2);

  const link = Array.from(doc.querySelectorAll('.file-link')).find(
    (anchor) => anchor.textContent === 'snake.py'
  );
  assert.ok(link);
  click(doc, link);
  assert.ok(posted.some((message) => message.type === 'openFile' && message.path === 'snake.py'));
});

test('reasoning is collapsed and shows a live character count', () => {
  const { doc, send } = createWebview();
  send({ type: 'reasoning', delta: 'think ' });
  send({ type: 'reasoning', delta: 'more' });
  send({ type: 'reasoning_end' });

  const details = doc.querySelector('details.reasoning');
  assert.ok(details);
  assert.equal(details.open, false);
  assert.match(details.querySelector('summary').textContent, /Reasoning · 10 chars/);
  assert.equal(details.querySelector('.reasoning-body').textContent.trim(), 'think more');
});

test('edit diff is expanded by default with green and red lines', () => {
  const { doc, send } = createWebview();
  send({
    type: 'diff',
    path: 'snake.py',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
    created: false,
    added: 1,
    removed: 1,
  });

  const edit = doc.querySelector('details.edit');
  assert.ok(edit);
  assert.equal(edit.open, true);
  assert.match(edit.querySelector('summary').textContent, /Edit file/);
  assert.equal(doc.querySelectorAll('.diff-line.add').length, 1);
  assert.equal(doc.querySelectorAll('.diff-line.del').length, 1);
});

test('done clears thinking and lists changed files', () => {
  const { doc, send } = createWebview();
  send({ type: 'delta', text: 'done' });
  send({
    type: 'diff',
    path: 'snake.py',
    diff: '--- a\n+++ b\n@@ -0,0 +1 @@\n+x\n',
    created: true,
    added: 1,
    removed: 0,
  });
  send({ type: 'done', stats: {} });

  assert.equal(doc.getElementById('status').textContent, '');
  assert.equal(doc.querySelectorAll('.files .file-link').length, 1);
  assert.match(doc.querySelector('details.edit summary').textContent, /New file/);
});

test('error clears the thinking state and resets the stream', () => {
  const { doc, send } = createWebview();
  send({ type: 'delta', text: 'partial' });
  send({ type: 'error', text: 'boom' });

  assert.equal(doc.getElementById('status').textContent, '');
  assert.ok(doc.querySelector('.msg.error'));
});

test('new chat resets the conversation and shows the empty state', async () => {
  const { doc, send, getState } = createWebview();
  send({ type: 'delta', text: 'hello' });
  send({ type: 'done', stats: {} });
  await tick();

  click(doc, doc.getElementById('newchat'));

  assert.equal(doc.querySelectorAll('#messages .msg').length, 0);
  assert.equal(doc.getElementById('empty').hidden, false);
  assert.equal(doc.querySelectorAll('#chats-list .chat-item').length, 2);
  const state = getState();
  const active = state.chats.find((chat) => chat.id === state.activeId);
  assert.equal(active.messages.length, 0);
});

test('new chat is blocked while a response is streaming', () => {
  const { doc, send } = createWebview();
  send({ type: 'delta', text: 'streaming' });

  click(doc, doc.getElementById('newchat'));

  assert.match(doc.getElementById('toasts').textContent, /Stop the current response first/);
  assert.ok(doc.querySelectorAll('#messages .msg').length >= 1);
});

test('chat drawer lists chats and can create a new one', () => {
  const { doc } = createWebview();
  click(doc, doc.getElementById('chats-toggle'));
  assert.ok(doc.getElementById('chat-drawer').classList.contains('open'));
  assert.ok(doc.querySelectorAll('#chats-list .chat-item').length >= 1);

  click(doc, doc.getElementById('drawer-newchat'));
  assert.equal(doc.querySelectorAll('#chats-list .chat-item').length, 2);
  assert.equal(doc.getElementById('chat-drawer').classList.contains('open'), false);
});

test('per-chat provider and reasoning are saved and sent', () => {
  const { doc, posted, getState } = createWebview();

  const provider = doc.getElementById('provider');
  provider.value = 'free';
  provider.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  const reasoning = doc.getElementById('reasoning');
  reasoning.value = 'high';
  reasoning.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));

  const state = getState();
  const active = state.chats.find((chat) => chat.id === state.activeId);
  assert.equal(active.provider, 'free');
  assert.equal(active.reasoningEffort, 'high');

  doc.getElementById('input').value = 'hello';
  click(doc, doc.getElementById('send'));

  const sendMessage = posted.find((message) => message.type === 'send');
  assert.ok(sendMessage);
  assert.equal(sendMessage.provider, 'free');
  assert.equal(sendMessage.reasoningEffort, 'high');
});

test('attachments: pick files, show chips, send with the message', () => {
  const { doc, posted, send } = createWebview();

  click(doc, doc.getElementById('attach'));
  assert.equal(doc.getElementById('attach-menu').hidden, false);
  click(doc, doc.getElementById('attach-file'));
  assert.ok(posted.some((message) => message.type === 'pickFiles'));

  send({ type: 'attachment', path: 'src/app.py', content: 'print(1)' });
  assert.equal(doc.getElementById('attachment-chips').hidden, false);
  assert.equal(doc.querySelectorAll('.attachment-chip').length, 1);

  doc.getElementById('input').value = 'use this file';
  click(doc, doc.getElementById('send'));

  const sendMessage = posted.find((message) => message.type === 'send');
  assert.ok(sendMessage);
  assert.equal(sendMessage.attachments.length, 1);
  assert.equal(sendMessage.attachments[0].path, 'src/app.py');
  assert.equal(doc.getElementById('attachment-chips').hidden, true);
});

test('user messages can be copied and edited', async () => {
  const { doc, posted, send } = createWebview();
  doc.getElementById('input').value = 'original request';
  click(doc, doc.getElementById('send'));
  send({ type: 'done', stats: {} });
  await tick();

  const user = doc.querySelector('.msg.user');
  assert.ok(user);

  const copy = Array.from(user.querySelectorAll('[title="Copy message"]'))[0];
  assert.ok(copy);
  click(doc, copy);
  const copyMessage = posted.find((message) => message.type === 'copyText');
  assert.ok(copyMessage);
  assert.equal(copyMessage.text, 'original request');

  const edit = Array.from(user.querySelectorAll('[title="Edit message"]'))[0];
  assert.ok(edit);
  click(doc, edit);
  assert.equal(doc.getElementById('input').value, 'original request');
});

test('tokens and context panels render separate panels', () => {
  const { doc, send } = createWebview();
  const stats = {
    prompt_tokens: 1234,
    completion_tokens: 567,
    cache_hit_tokens: 1000,
    cache_miss_tokens: 234,
    cost_usd: 0.000042,
    requests: 3,
    last_prompt_tokens: 1234,
    last_completion_tokens: 567,
    last_total_tokens: 1801,
    context_limit: 1000000,
    peak: false,
    provider: 'free',
    free_provider: 'freedeepseek',
    model: 'deepseek-flash',
    prices_per_m: { cache_hit: 0.003, cache_miss: 0.15, output: 0.6 },
  };
  send({ type: 'stats', stats });

  click(doc, doc.getElementById('tokens-btn'));
  assert.ok(doc.getElementById('tokens-panel').classList.contains('open'));
  assert.ok(doc.getElementById('tokens-content').textContent.length > 0);

  click(doc, doc.getElementById('tokens-close'));
  assert.equal(doc.getElementById('tokens-panel').classList.contains('open'), false);

  click(doc, doc.getElementById('context-btn'));
  assert.ok(doc.getElementById('context-panel').classList.contains('open'));
  assert.ok(doc.getElementById('context-content').textContent.length > 0);
});

test('stop button is shown while streaming and sends stopChat', () => {
  const { doc, posted, send } = createWebview();
  send({ type: 'delta', text: 'streaming' });

  const stop = doc.getElementById('stop');
  assert.equal(stop.hidden, false);
  assert.equal(stop.disabled, false);

  click(doc, stop);
  assert.ok(posted.some((message) => message.type === 'stopChat'));

  send({ type: 'stopped' });
  assert.equal(doc.getElementById('stop').hidden, true);
});

test('file code blocks offer an Apply button', async () => {
  const { doc, posted, send } = createWebview();
  send({
    type: 'delta',
    text: '```python file=src/app.py\nprint(1)\n```',
  });
  send({ type: 'done', stats: {} });
  await tick();

  const block = doc.querySelector('.code-block');
  assert.ok(block);
  const link = block.querySelector('.file-link');
  assert.equal(link.textContent, 'src/app.py');

  const apply = block.querySelector('.apply-file');
  assert.ok(apply);
  click(doc, apply);

  const message = posted.find((candidate) => candidate.type === 'applyFile');
  assert.ok(message);
  assert.equal(message.path, 'src/app.py');
  assert.equal(message.content, 'print(1)');
});

test('applied file adds a files chip', () => {
  const { doc, send } = createWebview();
  send({ type: 'appliedFile', path: 'src/app.py' });

  const chip = doc.querySelector('.files .file-link');
  assert.ok(chip);
  assert.equal(chip.textContent, 'src/app.py');
});

test('settings message restores provider and reasoning', () => {
  const { doc, send } = createWebview();
  send({ type: 'settings', reasoningEffort: 'low', provider: 'free' });

  assert.equal(doc.getElementById('provider').value, 'free');
  assert.equal(doc.getElementById('reasoning').value, 'low');
  assert.equal(doc.getElementById('brand').textContent, 'GPT 5.6 Terra');
});

test('settings button opens the setup wizard', () => {
  const { doc, posted } = createWebview();
  click(doc, doc.getElementById('settings-btn'));
  assert.ok(posted.some((message) => message.type === 'openSettings'));
});

test('chat state survives a webview reload', async () => {
  const first = createWebview();
  first.doc.getElementById('input').value = 'persist me';
  click(first.doc, first.doc.getElementById('send'));
  first.send({ type: 'done', stats: {} });
  await tick();

  const saved = first.getState();
  const second = createWebview(saved);

  assert.equal(second.doc.getElementById('chat-title').textContent, 'persist me');
  assert.equal(second.doc.querySelectorAll('#messages .msg.user').length, 1);
});
