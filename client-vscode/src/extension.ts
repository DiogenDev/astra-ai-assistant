import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

let backendProc: cp.ChildProcess | undefined;
let chatProvider: ChatViewProvider | undefined;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let dotenvToken = '';
let inlineBusy = false;
let inlineTimer: NodeJS.Timeout | undefined;
let inlineSuppressUntil = 0;
let inlinePendingLine: number | undefined;
let inlinePendingDoc: vscode.TextDocument | undefined;
let inlinePendingInstruction: string | undefined;

const INLINE_TRIGGER = /^\s*(?:#|\/\/|--|<!--|\/\*)\s*@?ai\s*:\s*(.*)$/i;

function parseInlineTrigger(lineText: string): string | null {
  const match = lineText.match(INLINE_TRIGGER);
  if (!match) {
    return null;
  }
  const instruction = match[1].replace(/\s*(?:-->|\*\/)\s*$/, '').trim();
  return instruction || null;
}

function cancelInlineTimer(): void {
  if (inlineTimer) {
    clearTimeout(inlineTimer);
    inlineTimer = undefined;
  }
  inlinePendingLine = undefined;
  inlinePendingDoc = undefined;
  inlinePendingInstruction = undefined;
}

function scheduleInlineRequest(
  editor: vscode.TextEditor,
  lineNumber: number,
  instruction: string
): void {
  cancelInlineTimer();
  inlinePendingLine = lineNumber;
  inlinePendingDoc = editor.document;
  inlinePendingInstruction = instruction;
  const delay = Math.max(500, cfg().get<number>('inlineRequest.idleDelayMs', 3000));
  inlineTimer = setTimeout(() => {
    inlineTimer = undefined;
    const pendingLine = inlinePendingLine;
    const pendingDoc = inlinePendingDoc;
    const pendingInstruction = inlinePendingInstruction;
    inlinePendingLine = undefined;
    inlinePendingDoc = undefined;
    inlinePendingInstruction = undefined;
    if (inlineBusy || !pendingInstruction || !pendingDoc) {
      return;
    }
    const active = vscode.window.activeTextEditor;
    if (!active || active.document !== pendingDoc) {
      return;
    }
    let target = -1;
    if (
      pendingLine !== undefined &&
      pendingLine < pendingDoc.lineCount &&
      parseInlineTrigger(pendingDoc.lineAt(pendingLine).text) === pendingInstruction
    ) {
      target = pendingLine;
    }
    if (target < 0) {
      for (let i = 0; i < pendingDoc.lineCount; i++) {
        if (parseInlineTrigger(pendingDoc.lineAt(i).text) === pendingInstruction) {
          target = i;
          break;
        }
      }
    }
    if (target < 0) {
      return;
    }
    void runInlineRequest(active, target, pendingInstruction);
  }, delay);
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('aiAssistant');
}

function authToken(): string {
  return cfg().get<string>('authToken', '') || dotenvToken || process.env.AI_ASSISTANT_TOKEN || '';
}

function readDotEnv(projectRoot: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const file = path.join(projectRoot, '.env');
    if (!fs.existsSync(file)) {
      return values;
    }
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) {
        continue;
      }
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
  } catch {
    // ignore .env read errors
  }
  return values;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await startExtension(context);
  } catch (err) {
    reportError('activation', err);
    throw err;
  }
}

async function startExtension(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('AI Assistant');
  context.subscriptions.push(output);
  output.appendLine('[AI Assistant] activating...');

  try {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = '$(sync~spin) AI';
    statusBar.tooltip = 'AI Assistant: starting backend...';
    statusBar.command = 'aiAssistant.openChat';
    statusBar.show();
    context.subscriptions.push(statusBar);
  } catch (err) {
    reportError('status bar', err);
  }

  chatProvider = new ChatViewProvider(context);

  safeRegister('chat view', context, () =>
    vscode.window.registerWebviewViewProvider('aiAssistant.chatView', chatProvider as ChatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  safeRegister('command openChat', context, () =>
    vscode.commands.registerCommand('aiAssistant.openChat', () => {
      void vscode.commands.executeCommand('aiAssistant.chatView.focus');
    })
  );
  safeRegister('command explainSelection', context, () =>
    vscode.commands.registerCommand('aiAssistant.explainSelection', () =>
      runPreset('Explain the selected code in detail.')
    )
  );
  safeRegister('command fixSelection', context, () =>
    vscode.commands.registerCommand('aiAssistant.fixSelection', () =>
      runPreset('Find bugs and issues in the selected code and propose fixes.')
    )
  );
  safeRegister('inline completions', context, () =>
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new InlineProvider())
  );
  safeRegister('inline request command', context, () =>
    vscode.commands.registerCommand('aiAssistant.runInlineRequest', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const line = editor.selection.active.line;
      let target = line;
      let instruction = parseInlineTrigger(editor.document.lineAt(line).text);
      if (!instruction && line > 0) {
        target = line - 1;
        instruction = parseInlineTrigger(editor.document.lineAt(target).text);
      }
      if (!instruction) {
        void vscode.window.showInformationMessage(
          'AI Assistant: write a comment like "# ai: your request" and press Enter (or run this command on that line).'
        );
        return;
      }
      void runInlineRequest(editor, target, instruction);
    })
  );
  safeRegister('inline request watcher', context, () =>
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (inlineBusy || Date.now() < inlineSuppressUntil) {
        return;
      }
      if (
        !cfg().get<boolean>('inlineRequest.enabled', true) ||
        !cfg().get<boolean>('inlineRequest.auto', true)
      ) {
        cancelInlineTimer();
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || event.document !== editor.document || event.document.uri.scheme !== 'file') {
        cancelInlineTimer();
        return;
      }
      let triggerLine = -1;
      let instruction = '';
      for (const change of event.contentChanges) {
        const line = change.range.start.line;
        if (line < event.document.lineCount) {
          const parsed = parseInlineTrigger(event.document.lineAt(line).text);
          if (parsed) {
            triggerLine = line;
            instruction = parsed;
            break;
          }
        }
      }
      if (triggerLine >= 0) {
        scheduleInlineRequest(editor, triggerLine, instruction);
        return;
      }
      if (inlinePendingDoc === event.document && inlinePendingInstruction !== undefined) {
        scheduleInlineRequest(editor, inlinePendingLine ?? 0, inlinePendingInstruction);
        return;
      }
      cancelInlineTimer();
    })
  );
  safeRegister('inline request editor switch', context, () =>
    vscode.window.onDidChangeActiveTextEditor(() => cancelInlineTimer())
  );

  if (vscode.workspace.isTrusted !== false && !context.globalState.get<boolean>('aiAssistant.welcomed')) {
    void context.globalState.update('aiAssistant.welcomed', true);
    void vscode.window
      .showInformationMessage(
        'GPT 6 Astra is installed. Open the chat, or write "# ai: ..." in a comment and pause for 3 seconds.',
        'Open Chat'
      )
      .then((choice) => {
        if (choice === 'Open Chat') {
          void vscode.commands.executeCommand('aiAssistant.openChat');
        }
      });
  }

  context.subscriptions.push({ dispose: () => stopBackend() });

  try {
    await startBackend(context);
  } catch (err) {
    reportError('backend startup', err);
  }
}

function safeRegister(
  label: string,
  context: vscode.ExtensionContext,
  setup: () => vscode.Disposable
): void {
  try {
    context.subscriptions.push(setup());
  } catch (err) {
    reportError(label, err);
  }
}

function reportError(label: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  output?.appendLine(`[AI Assistant] ${label} failed: ${message}`);
  console.error(`[AI Assistant] ${label} failed:`, err);
}

export function deactivate(): void {
  cancelInlineTimer();
  stopBackend();
}

function resolveBackendRoot(context: vscode.ExtensionContext): string {
  const configured = cfg().get<string>('backendRoot', '').trim();
  const candidates: string[] = [];
  if (configured) {
    candidates.push(configured);
  }
  candidates.push(path.dirname(context.extensionPath));
  candidates.push(context.extensionPath);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'backend', 'main.py'))) {
      return candidate;
    }
  }
  return configured || path.dirname(context.extensionPath);
}

async function startBackend(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.workspace.isTrusted === false) {
    markRestricted();
    return;
  }

  const port = cfg().get<number>('port', 8765);
  const projectRoot = resolveBackendRoot(context);
  const hasBackend = fs.existsSync(path.join(projectRoot, 'backend', 'main.py'));
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? projectRoot;
  const python = cfg().get<string>('pythonPath', 'python');
  const dotenv = readDotEnv(projectRoot);
  dotenvToken = dotenv.AUTH_TOKEN ?? '';
  if (dotenvToken) {
    output.appendLine('[AI Assistant] using AUTH_TOKEN from .env');
  }

  if (await waitForHealth(port, 1)) {
    output.appendLine(`[AI Assistant] backend already running on port ${port}.`);
    const health = await fetchHealth();
    const backendWorkspace = health?.workspace ?? '';
    if (backendWorkspace && !samePath(backendWorkspace, workspace)) {
      const warning =
        `External backend works on ${backendWorkspace}, but the open VS Code workspace is ${workspace}. ` +
        'File edits will go to the backend workspace. Stop run.bat so the extension starts its own backend, ' +
        'or start it as: run.bat "<workspace path>".';
      output.appendLine(`[AI Assistant] WARNING: ${warning}`);
      void vscode.window
        .showWarningMessage(`AI Assistant: ${warning}`, 'Open Output')
        .then((choice) => {
          if (choice === 'Open Output') {
            output.show();
          }
        });
    }
    setBackendReady();
    return;
  }

  if (!hasBackend) {
    output.appendLine(
      `[AI Assistant] backend package not found under ${projectRoot}; waiting for an external backend (run.bat).`
    );
    if (await waitForHealth(port, 10)) {
      setBackendReady();
    } else {
      markBackendError('backend not found. Set aiAssistant.backendRoot or start run.bat.');
    }
    return;
  }

  if (!cfg().get<boolean>('autoStartBackend', true)) {
    output.appendLine('[AI Assistant] autoStartBackend disabled; waiting for external backend.');
    if (await waitForHealth(port, 10)) {
      setBackendReady();
    } else {
      markBackendError('backend not reachable. Start run.bat or set aiAssistant.autoStartBackend=true.');
    }
    return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: workspace, PORT: String(port) };
  const token = cfg().get<string>('authToken', '');
  if (token) {
    env.AUTH_TOKEN = token;
  }

  output.appendLine(`[AI Assistant] starting backend: ${python} -m uvicorn backend.main:app --port ${port}`);
  backendProc = cp.spawn(
    python,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: projectRoot, env, windowsHide: true }
  );
  backendProc.stdout?.on('data', (data: Buffer) => output.append(data.toString()));
  backendProc.stderr?.on('data', (data: Buffer) => output.append(data.toString()));
  backendProc.on('error', (err) => output.appendLine(`Backend spawn error: ${err.message}`));
  backendProc.on('exit', (code) => output.appendLine(`Backend exited with code ${code}`));

  if (await waitForHealth(port, 20)) {
    setBackendReady();
  } else {
    markBackendError(
      'backend failed to start. Check aiAssistant.pythonPath and Output -> AI Assistant.'
    );
  }
}

function markRestricted(): void {
  if (statusBar) {
    statusBar.text = '$(lock) AI';
    statusBar.tooltip = 'AI Assistant: workspace is in Restricted Mode';
  }
  output.appendLine('[AI Assistant] workspace is not trusted; backend not started.');
  void vscode.window
    .showWarningMessage(
      'AI Assistant is in Restricted Mode. Trust this workspace to enable the agent.',
      'Manage Trust'
    )
    .then((choice) => {
      if (choice === 'Manage Trust') {
        void vscode.commands.executeCommand('workbench.workspaceTrust.manage');
      }
    });
}

function markBackendError(message: string): void {
  if (statusBar) {
    statusBar.text = '$(warning) AI';
    statusBar.tooltip = `AI Assistant: ${message}`;
  }
  output.appendLine(`[AI Assistant] ${message}`);
  void vscode.window.showWarningMessage(`AI Assistant: ${message}`);
}

function setBackendReady(): void {
  if (statusBar) {
    statusBar.text = '$(sparkle) AI';
    statusBar.tooltip = 'AI Assistant: ready. Click to open chat.';
  }
  output?.appendLine('[AI Assistant] backend is ready');
}

function stopBackend(): void {
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
    backendProc = undefined;
  }
}

async function waitForHealth(port: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await httpJson('GET', `http://127.0.0.1:${port}/health`, undefined, '', 1500);
      if (res.status === 200) {
        return true;
      }
    } catch {
      // not up yet
    }
    await delay(500);
  }
  return false;
}

interface HttpResult {
  status: number;
  body: string;
}

function httpJson(
  method: string,
  urlStr: string,
  body: unknown,
  token: string,
  timeoutMs = 30000
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

interface HealthInfo {
  status?: string;
  workspace?: string;
}

async function fetchHealth(): Promise<HealthInfo | null> {
  const base = cfg().get<string>('apiUrl', 'http://127.0.0.1:8765');
  try {
    const res = await httpJson(
      'GET',
      new URL('/health', base).toString(),
      undefined,
      '',
      3000
    );
    if (res.status !== 200) {
      return null;
    }
    return JSON.parse(res.body) as HealthInfo;
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function fetchStats(): Promise<any | null> {
  const base = cfg().get<string>('apiUrl', 'http://127.0.0.1:8765');
  try {
    const res = await httpJson(
      'GET',
      new URL('/stats', base).toString(),
      undefined,
      authToken(),
      5000
    );
    if (res.status !== 200) {
      return null;
    }
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function streamChat(
  payload: unknown,
  token: string,
  onEvent: (event: any) => void,
  onError: (err: Error) => void
): void {
  const base = cfg().get<string>('apiUrl', 'http://127.0.0.1:8765');
  const url = new URL('/chat', base);
  const data = JSON.stringify(payload);
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    Accept: 'text/event-stream',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
    (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        let errBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (errBody += chunk));
        res.on('end', () => onError(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) {
              continue;
            }
            const json = line.slice(5).trim();
            if (!json) {
              continue;
            }
            try {
              onEvent(JSON.parse(json));
            } catch {
              // ignore malformed event
            }
          }
        }
      });
      res.on('end', () => onEvent({ type: 'done' }));
    }
  );
  req.on('error', onError);
  req.write(data);
  req.end();
}

class InlineProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    cancellationToken: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    if (!cfg().get<boolean>('enableInline', true) || document.uri.scheme !== 'file') {
      return [];
    }
    if (document.lineCount > 20000) {
      return [];
    }
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      await delay(350);
      if (cancellationToken.isCancellationRequested) {
        return [];
      }
    }

    const offset = document.offsetAt(position);
    const full = document.getText();
    const prefix = full.slice(Math.max(0, offset - 4000), offset);
    const suffix = full.slice(offset, Math.min(full.length, offset + 2000));
    if (!prefix.trim()) {
      return [];
    }

    const base = cfg().get<string>('apiUrl', 'http://127.0.0.1:8765');
    try {
      const res = await httpJson(
        'POST',
        new URL('/complete', base).toString(),
        {
          prefix,
          suffix,
          file_path: vscode.workspace.asRelativePath(document.uri, false),
          language_id: document.languageId,
          max_tokens: 160,
        },
        authToken(),
        15000
      );
      if (cancellationToken.isCancellationRequested || res.status !== 200) {
        return [];
      }
      const parsed = JSON.parse(res.body) as { completion?: string };
      const completion = (parsed.completion ?? '').replace(/\s+$/, '');
      if (!completion.trim()) {
        return [];
      }
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch {
      return [];
    }
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pending: unknown[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: any) => {
      void this.handleMessage(message);
    });

    const timer = setInterval(() => {
      if (view.visible) {
        void this.refreshStats();
      }
    }, 5000);
    view.onDidDispose(() => clearInterval(timer));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refreshStats();
      }
    });
  }

  private async refreshStats(): Promise<void> {
    const stats = await fetchStats();
    if (stats) {
      this.post({ type: 'stats', stats });
    }
  }

  post(message: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    } else {
      this.pending.push(message);
    }
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        for (const item of this.pending) {
          void this.view?.webview.postMessage(item);
        }
        this.pending = [];
        this.post({
          type: 'settings',
          reasoningEffort: cfg().get<string>('reasoningEffort', 'medium'),
        });
        void this.refreshStats();
        break;
      case 'getStats':
        void this.refreshStats();
        break;
      case 'setReasoning':
        await cfg().update(
          'reasoningEffort',
          String(message.value ?? 'medium'),
          vscode.ConfigurationTarget.Global
        );
        break;
      case 'send':
        this.send(String(message.text ?? ''), message.history ?? []);
        break;
      case 'insert':
        await insertIntoEditor(String(message.text ?? ''));
        break;
      case 'openFile':
        await openWorkspaceFile(
          String(message.path ?? ''),
          message.absPath ? String(message.absPath) : undefined
        );
        break;
      case 'openExternal': {
        const url = String(message.url ?? '');
        if (/^https?:\/\//i.test(url)) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
    }
  }

  private send(text: string, history: Array<{ role: string; content: string }>): void {
    if (!text.trim()) {
      return;
    }
    const payload = {
      messages: [...history, { role: 'user', content: text }],
      context: collectContext(),
      reasoning_effort: cfg().get<string>('reasoningEffort', 'medium'),
    };
    streamChat(
      payload,
      authToken(),
      (event: any) => {
        switch (event?.type) {
          case 'text':
            this.post({ type: 'delta', text: event.delta });
            break;
          case 'tool':
            this.post({ type: 'status', text: `Tool: ${event.name}` });
            break;
          case 'tool_result':
            this.post({
              type: 'tool_result',
              text: `${event.name}: ${String(event.result).slice(0, 200)}`,
            });
            break;
          case 'error':
            this.post({ type: 'error', text: event.message });
            break;
          case 'done':
            if (event.stats) {
              this.post({ type: 'stats', stats: event.stats });
            }
            this.post({ type: 'done' });
            break;
        }
      },
      (err: Error) => {
        const hint = /ECONNREFUSED|connect/i.test(err.message)
          ? ' Backend is not running. See Output -> AI Assistant.'
          : '';
        this.post({ type: 'error', text: err.message + hint });
      }
    );
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${css}" />
<title>AI Assistant</title>
</head>
<body>
  <div id="topbar">
    <span id="brand">GPT 6 Astra</span>
    <select id="reasoning" title="Reasoning effort">
      <option value="auto">auto</option>
      <option value="none">none</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
    </select>
  </div>
  <div id="stats">no requests yet</div>
  <div id="messages"></div>
  <div id="status"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask about your code..."></textarea>
    <div id="actions">
      <button id="insert" title="Insert last answer at cursor">Insert</button>
      <button id="send">Send</button>
    </div>
  </div>
  <script src="${js}"></script>
</body>
</html>`;
  }
}

function collectContext(): Record<string, unknown> | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const doc = editor.document;
  const selection = editor.selection;
  const selected = selection && !selection.isEmpty ? doc.getText(selection) : '';
  const text = doc.getText();
  return {
    file_path: vscode.workspace.asRelativePath(doc.uri, false),
    language_id: doc.languageId,
    selection: selected,
    content: text.length > 12000 ? text.slice(0, 12000) : text,
  };
}

async function openWorkspaceFile(rawPath: string, absPath?: string): Promise<void> {
  if (!rawPath) {
    return;
  }
  const roots: string[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    roots.push(folder.uri.fsPath);
  }
  const configuredRoot = cfg().get<string>('backendRoot', '').trim();
  if (configuredRoot) {
    roots.push(configuredRoot);
  }
  const health = await fetchHealth();
  if (health?.workspace) {
    roots.push(health.workspace);
  }

  const allowed = Array.from(
    new Set(roots.map((root) => path.resolve(root).toLowerCase()))
  );

  const candidates: string[] = [];
  if (absPath && path.isAbsolute(absPath)) {
    candidates.push(absPath);
  }
  if (path.isAbsolute(rawPath)) {
    candidates.push(rawPath);
  }
  for (const root of roots) {
    candidates.push(path.join(root, rawPath));
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const inside = allowed.some(
      (root) => resolved.toLowerCase() === root || resolved.toLowerCase().startsWith(root + path.sep)
    );
    if (!inside || !fs.existsSync(resolved)) {
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    } catch {
      // try the next candidate
    }
  }

  void vscode.window.showWarningMessage(
    `AI Assistant: cannot find ${rawPath}. Checked: ${candidates.join(' | ')}`
  );
}

async function insertIntoEditor(text: string): Promise<void> {
  if (!text) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  await editor.edit((builder) => builder.replace(editor.selection, text));
}

async function runPreset(prompt: string): Promise<void> {
  await vscode.commands.executeCommand('aiAssistant.chatView.focus');
  const editor = vscode.window.activeTextEditor;
  let text = prompt;
  if (editor && !editor.selection.isEmpty) {
    text +=
      '\n\nSelected code:\n```' +
      editor.document.languageId +
      '\n' +
      editor.document.getText(editor.selection) +
      '\n```';
  }
  chatProvider?.post({ type: 'preset', text });
}

async function runInlineRequest(
  editor: vscode.TextEditor,
  lineNumber: number,
  instruction: string
): Promise<void> {
  if (inlineBusy) {
    return;
  }
  cancelInlineTimer();
  if (vscode.workspace.isTrusted === false) {
    void vscode.window.showWarningMessage(
      'AI Assistant: inline requests are disabled in Restricted Mode.'
    );
    return;
  }
  const document = editor.document;
  if (document.uri.scheme !== 'file') {
    return;
  }

  const originalText = document.getText();
  const originalLine = document.lineAt(lineNumber).text;
  inlineBusy = true;
  try {
    const payload = {
      instruction,
      file_path: vscode.workspace.asRelativePath(document.uri, false),
      language_id: document.languageId,
      content: originalText.slice(0, 40000),
      line: lineNumber + 1,
      reasoning_effort: cfg().get<string>('reasoningEffort', 'medium'),
    };
    const base = cfg().get<string>('apiUrl', 'http://127.0.0.1:8765');
    const response = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'GPT 6 Astra: inline edit...',
      },
      () => httpJson('POST', new URL('/inline', base).toString(), payload, authToken(), 180000)
    );
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${response.body}`);
    }

    const parsed = JSON.parse(response.body) as { content?: string };
    const next = (parsed.content ?? '').replace(/\s+$/, '');
    if (!next.trim()) {
      throw new Error('the model returned an empty file');
    }
    if (document.getText() !== originalText) {
      throw new Error('the file changed while generating the edit; try again');
    }
    if (lineNumber >= document.lineCount || document.lineAt(lineNumber).text !== originalLine) {
      throw new Error('the instruction line changed while generating the edit; try again');
    }
    if (originalText.length > 2000 && next.length < originalText.length * 0.5) {
      throw new Error('the model returned a suspiciously short file; edit rejected');
    }
    if (next === originalText) {
      void vscode.window.showInformationMessage('GPT 6 Astra: no changes were needed.');
      return;
    }

    const start = document.positionAt(0);
    const end = document.positionAt(originalText.length);
    inlineSuppressUntil = Date.now() + 1500;
    const applied = await editor.edit((builder) => {
      builder.replace(new vscode.Range(start, end), next);
    });
    if (!applied) {
      throw new Error('could not apply the edit');
    }
    output?.appendLine(
      `[AI Assistant] inline request applied: ${document.uri.fsPath}:${lineNumber + 1}`
    );
    void vscode.window
      .showInformationMessage('GPT 6 Astra applied the inline edit.', 'Undo')
      .then((choice) => {
        if (choice === 'Undo') {
          void vscode.commands.executeCommand('undo');
        }
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output?.appendLine(`[AI Assistant] inline request failed: ${message}`);
    void vscode.window.showErrorMessage(`GPT 6 Astra inline request failed: ${message}`);
  } finally {
    cancelInlineTimer();
    inlineBusy = false;
  }
}