import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
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

const MAX_ATTACHMENT_BYTES = 200 * 1024;
const MAX_ATTACHMENTS = 8;
const PROVIDERS = new Set(['auto', 'deepseek', 'free']);
const EFFORT_LEVELS = new Set(['auto', 'none', 'low', 'medium', 'high']);

interface AttachmentPayload {
  path: string;
  content: string;
}

function normalizeProvider(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase();
  return PROVIDERS.has(key) ? key : 'auto';
}

function normalizeReasoning(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase();
  return EFFORT_LEVELS.has(key) ? key : 'medium';
}

function sanitizeAttachments(value: unknown): AttachmentPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: AttachmentPayload[] = [];
  for (const item of value.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rawPath = String((item as { path?: unknown }).path ?? '').slice(0, 400);
    if (!rawPath) {
      continue;
    }
    result.push({
      path: rawPath,
      content: String((item as { content?: unknown }).content ?? '').slice(
        0,
        MAX_ATTACHMENT_BYTES
      ),
    });
  }
  return result;
}

function attachmentDisplayPath(fsPath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const relative = path.relative(folder.uri.fsPath, fsPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return fsPath;
}

function readAttachmentFile(fsPath: string): AttachmentPayload | null {
  try {
    const stat = fs.statSync(fsPath);
    if (!stat.isFile()) {
      return null;
    }
    const size = Math.min(stat.size, MAX_ATTACHMENT_BYTES);
    let content = '';
    if (size > 0) {
      const buffer = Buffer.alloc(size);
      const fd = fs.openSync(fsPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, size, 0);
      } finally {
        fs.closeSync(fd);
      }
      content = buffer.toString('utf8');
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      content += '\n\u2026[truncated]';
    }
    return { path: attachmentDisplayPath(fsPath), content };
  } catch {
    return null;
  }
}

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

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
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

function readDotEnv(projectRoot: string): Record<string, string> {
  return readEnvFile(path.join(projectRoot, '.env'));
}

function configEnvFile(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'ai-assistant.env');
}

function writeEnvFile(file: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(file, body + '\n', 'utf8');
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
  safeRegister('command setup', context, () =>
    vscode.commands.registerCommand('aiAssistant.setup', () => runSetupWizard(context))
  );
  safeRegister('command installDeps', context, () =>
    vscode.commands.registerCommand('aiAssistant.installDeps', () =>
      installBackendDependencies(context)
    )
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
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file', pattern: '**' },
      new InlineProvider()
    )
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

  try {
    await ensureFreeProxy();
  } catch (err) {
    reportError('free proxy startup', err);
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
  const envFile = configEnvFile(context);
  const fileEnv = fs.existsSync(envFile) ? readEnvFile(envFile) : readDotEnv(projectRoot);
  dotenvToken = cfg().get<string>('authToken', '') || fileEnv.AUTH_TOKEN || '';
  if (dotenvToken) {
    output.appendLine('[AI Assistant] using AUTH_TOKEN from the AI Assistant config');
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
  if (fs.existsSync(envFile)) {
    env.ENV_FILE = envFile;
  }
  const token = cfg().get<string>('authToken', '') || fileEnv.AUTH_TOKEN || '';
  if (token) {
    env.AUTH_TOKEN = token;
  }
  const deepseekKey = await context.secrets.get('aiAssistant.deepseekApiKey');
  if (deepseekKey) {
    env.DEEPSEEK_API_KEY = deepseekKey;
  }
  const freeKey = await context.secrets.get('aiAssistant.freeApiKey');
  if (freeKey) {
    env.FREE_API_KEY = freeKey;
  }
  env.DEEPSEEK_MODEL = cfg().get<string>('model', 'deepseek-flash');
  env.PROVIDER = cfg().get<string>('provider', 'auto');
  env.FREE_PROVIDER = cfg().get<string>('freeProvider', 'freedeepseek');
  env.REASONING_EFFORT = cfg().get<string>('reasoningEffort', 'medium');
  env.CONTEXT_LIMIT = String(cfg().get<number>('contextLimit', 1000000));

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

function resolveFreeDeepseekRoot(): string {
  const configured = cfg().get<string>('freeDeepseekRoot', '').trim();
  if (configured) {
    return configured;
  }
  return path.join(os.homedir(), 'Documents', 'GitHub', 'FreeDeepseekAPI');
}

async function freeProxyHealthy(): Promise<boolean> {
  try {
    const res = await httpJson('GET', 'http://127.0.0.1:9655/health', undefined, '', 1500);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForFreeProxy(attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await freeProxyHealthy()) {
      return true;
    }
    await delay(500);
  }
  return false;
}

async function ensureFreeProxy(): Promise<void> {
  if (!cfg().get<boolean>('autoStartFreeAi', true)) {
    return;
  }
  if (vscode.workspace.isTrusted === false) {
    return;
  }
  const health = await fetchHealth();
  if (health?.free_provider && health.free_provider !== 'freedeepseek') {
    return;
  }
  if (await freeProxyHealthy()) {
    output.appendLine('[AI Assistant] FreeDeepseekAPI already running.');
    return;
  }

  const root = resolveFreeDeepseekRoot();
  const serverFile = path.join(root, 'server.js');
  if (!fs.existsSync(serverFile)) {
    output.appendLine(`[AI Assistant] FreeDeepseekAPI not found at ${root}.`);
    void vscode.window.showWarningMessage(
      `Free mode needs FreeDeepseekAPI at ${root}. Run start-free-ai.bat first.`
    );
    return;
  }
  if (!fs.existsSync(path.join(root, 'deepseek-auth.json'))) {
    output.appendLine('[AI Assistant] FreeDeepseekAPI has no DeepSeek login yet.');
    void vscode.window
      .showWarningMessage(
        'Free mode needs a one-time DeepSeek login. Run start-free-ai.bat and log in to chat.deepseek.com.',
        'Open Folder'
      )
      .then((choice) => {
        if (choice === 'Open Folder') {
          void vscode.env.openExternal(vscode.Uri.file(root));
        }
      });
    return;
  }

  const node = cfg().get<string>('nodePath', 'node');
  let outFd: number | 'ignore' = 'ignore';
  let errFd: number | 'ignore' = 'ignore';
  try {
    outFd = fs.openSync(path.join(root, 'proxy.out.log'), 'a');
    errFd = fs.openSync(path.join(root, 'proxy.err.log'), 'a');
  } catch {
    outFd = 'ignore';
    errFd = 'ignore';
  }

  const child = cp.spawn(node, ['server.js'], {
    cwd: root,
    env: { ...process.env, NON_INTERACTIVE: '1' },
    windowsHide: true,
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.on('error', (error) => {
    output.appendLine(`[AI Assistant] FreeDeepseekAPI spawn error: ${error.message}`);
  });
  child.unref();
  if (typeof outFd === 'number') {
    try {
      fs.closeSync(outFd);
    } catch {
      // ignore
    }
  }
  if (typeof errFd === 'number') {
    try {
      fs.closeSync(errFd);
    } catch {
      // ignore
    }
  }
  output.appendLine(`[AI Assistant] starting FreeDeepseekAPI from ${root} (pid ${child.pid ?? '?'})`);

  // Do not block extension activation while the proxy boots.
  void waitForFreeProxy(30).then((ready) => {
    if (ready) {
      output.appendLine('[AI Assistant] FreeDeepseekAPI is ready.');
      return;
    }
    output.appendLine('[AI Assistant] FreeDeepseekAPI did not become ready.');
    void vscode.window.showWarningMessage(
      'FreeDeepseekAPI did not start. Check proxy.err.log in its folder.'
    );
  });
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
  provider?: string;
  free_provider?: string;
  free_ready?: boolean;
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
): { abort: () => void } {
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

  let idleTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let sawDone = false;
  let armIdle: () => void = () => undefined;

  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const finish = (err?: Error): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearIdle();
    if (err) {
      onError(err);
    }
  };

  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
    (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        let errBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (errBody += chunk));
        res.on('end', () => finish(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        armIdle();
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
              const event = JSON.parse(json);
              if (event && event.type === 'done') {
                sawDone = true;
              }
              onEvent(event);
            } catch {
              // ignore malformed event
            }
          }
        }
      });
      res.on('end', () => {
        if (!finished) {
          finish();
          if (!sawDone) {
            onEvent({ type: 'done' });
          }
        }
      });
      res.on('error', (err) => finish(err));
    }
  );

  armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      finish(new Error('backend stopped responding (150s idle)'));
      req.destroy();
    }, 150000);
  };

  req.setTimeout(240000, () => {
    finish(new Error('request timeout (240s)'));
    req.destroy();
  });
  req.on('error', (err) => finish(err));
  armIdle();
  req.write(data);
  req.end();

  return {
    abort: () => {
      finish();
      req.destroy();
    },
  };
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
  private activeStream: { abort: () => void } | undefined;
  private stopRequested = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: any) => {
      void this.handleMessage(message).catch((err) => reportError('webview message', err));
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
          provider: cfg().get<string>('provider', 'auto'),
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
      case 'setProvider':
        await cfg().update(
          'provider',
          String(message.value ?? 'auto'),
          vscode.ConfigurationTarget.Global
        );
        if (String(message.value ?? '') === 'free') {
          void ensureFreeProxy();
        }
        break;
      case 'send':
        this.send(String(message.text ?? ''), message.history ?? [], {
          provider: message.provider,
          reasoningEffort: message.reasoningEffort,
          attachments: message.attachments,
        });
        break;
      case 'stopChat':
        this.stopChat();
        break;
      case 'copyText': {
        try {
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          this.post({ type: 'copied' });
        } catch {
          this.post({ type: 'toast', text: 'Could not copy to the clipboard' });
        }
        break;
      }
      case 'pickFiles':
        await this.attachFilesFromDialog();
        break;
      case 'addPath':
        await this.attachFileFromInput();
        break;
      case 'insert': {
        const inserted = await insertIntoEditor(String(message.text ?? ''));
        if (inserted) {
          this.post({ type: 'toast', text: 'Inserted' });
        }
        break;
      }
      case 'openFile':
        await openWorkspaceFile(
          String(message.path ?? ''),
          message.absPath ? String(message.absPath) : undefined
        );
        break;
      case 'applyFile': {
        const applied = await applyWorkspaceFile(
          String(message.path ?? ''),
          String(message.content ?? '')
        );
        if (applied) {
          this.post({ type: 'appliedFile', path: String(message.path ?? '') });
        }
        break;
      }
      case 'openExternal': {
        const url = String(message.url ?? '');
        if (/^https?:\/\//i.test(url)) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('aiAssistant.setup');
        break;
    }
  }

  private send(
    text: string,
    history: Array<{ role: string; content: string }>,
    options?: { provider?: unknown; reasoningEffort?: unknown; attachments?: unknown }
  ): void {
    if (!text.trim()) {
      return;
    }
    const provider = normalizeProvider(
      options?.provider ?? cfg().get<string>('provider', 'auto')
    );
    const reasoningEffort = normalizeReasoning(
      options?.reasoningEffort ?? cfg().get<string>('reasoningEffort', 'medium')
    );
    const attachments = sanitizeAttachments(options?.attachments);
    const baseContext = collectContext();
    const context = attachments.length
      ? { ...(baseContext ?? {}), attachments }
      : baseContext;
    const payload = {
      messages: [...history, { role: 'user', content: text }],
      context,
      reasoning_effort: reasoningEffort,
      provider,
    };

    if (this.activeStream) {
      this.stopRequested = true;
      this.activeStream.abort();
      this.activeStream = undefined;
    }
    this.stopRequested = false;

    this.activeStream = streamChat(
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
          case 'link': {
            const url = String(event.url ?? '');
            this.post({ type: 'link', url, text: String(event.text ?? 'Open link') });
            if (/^https?:\/\//i.test(url)) {
              void vscode.env.openExternal(vscode.Uri.parse(url));
            }
            break;
          }
          case 'error':
            output?.appendLine(`[AI Assistant] chat error: ${event.message}`);
            this.post({ type: 'error', text: event.message });
            break;
          case 'done':
            this.activeStream = undefined;
            if (event.stats) {
              this.post({ type: 'stats', stats: event.stats });
            }
            this.post({ type: 'done' });
            break;
        }
      },
      (err: Error) => {
        this.activeStream = undefined;
        if (this.stopRequested) {
          this.stopRequested = false;
          return;
        }
        const hint = /ECONNREFUSED|connect/i.test(err.message)
          ? ' Backend is not running. See Output -> AI Assistant.'
          : '';
        this.post({ type: 'error', text: err.message + hint });
      }
    );
  }

  private stopChat(): void {
    this.stopRequested = true;
    const active = this.activeStream;
    this.activeStream = undefined;
    if (active) {
      active.abort();
      this.post({ type: 'stopped' });
      this.post({ type: 'done' });
      return;
    }
    this.post({ type: 'done' });
  }

  private async attachFilesFromDialog(): Promise<void> {
    let selected: vscode.Uri[] | undefined;
    try {
      selected = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        title: 'Attach files to the chat',
      });
    } catch (err) {
      reportError('attach files', err);
      this.post({ type: 'attachmentError', text: 'Could not open the file picker' });
      return;
    }
    if (!selected || !selected.length) {
      return;
    }
    for (const uri of selected.slice(0, MAX_ATTACHMENTS)) {
      const attachment = readAttachmentFile(uri.fsPath);
      if (attachment) {
        this.post({ type: 'attachment', path: attachment.path, content: attachment.content });
      } else {
        this.post({
          type: 'attachmentError',
          text: `Could not read ${path.basename(uri.fsPath)}`,
        });
      }
    }
  }

  private async attachFileFromInput(): Promise<void> {
    let value: string | undefined;
    try {
      value = await vscode.window.showInputBox({
        prompt: 'Path to attach (relative to the workspace)',
        placeHolder: 'src/app.py',
        ignoreFocusOut: true,
      });
    } catch (err) {
      reportError('attach path', err);
      this.post({ type: 'attachmentError', text: 'Could not open the path input' });
      return;
    }
    const requested = String(value ?? '').trim();
    if (!requested) {
      return;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const resolved = resolveWorkspaceTarget(requested, roots);
    if (!resolved) {
      this.post({
        type: 'attachmentError',
        text: 'Path must be inside the open workspace',
      });
      return;
    }
    const attachment = readAttachmentFile(resolved);
    if (!attachment) {
      this.post({ type: 'attachmentError', text: `Could not read ${requested}` });
      return;
    }
    this.post({ type: 'attachment', path: attachment.path, content: attachment.content });
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
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
  <header id="topbar" class="topbar">
    <div class="topbar-row">
      <button id="chats-toggle" class="icon-btn" type="button" aria-label="Open chats" aria-haspopup="dialog" aria-expanded="false" title="Chats">
        <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 2.5V12A2 2 0 0 1 4 10z"/><path d="M16.5 8H18a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5v2.5L14 16h-2"/></svg></span>
      </button>
      <div class="title-block">
        <span id="brand" class="brand">GPT 6 Astra</span>
        <span id="chat-title" class="chat-title">New chat</span>
      </div>
      <div class="topbar-actions">
        <button id="settings-btn" class="icon-btn" type="button" aria-label="Setup and settings" title="Setup / Settings">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-3v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-3h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h3v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v3h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></span>
        </button>
        <button id="tokens-btn" class="ghost-btn" type="button" aria-label="Token usage" aria-haspopup="dialog" aria-expanded="false" title="Token usage">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg></span>
          <span class="btn-label">Tokens</span>
        </button>
        <button id="context-btn" class="ghost-btn" type="button" aria-label="Context usage" aria-haspopup="dialog" aria-expanded="false" title="Context usage">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8M8 16h5"/></svg></span>
          <span class="btn-label">Context</span>
        </button>
        <button id="newchat" class="icon-btn accent" type="button" aria-label="New chat" title="New chat">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg></span>
        </button>
      </div>
    </div>
    <div class="topbar-row controls">
      <select id="provider" aria-label="Model provider" title="Model">
        <option value="auto">Auto</option>
        <option value="deepseek">GPT 6 Astra</option>
        <option value="free">GPT 5.6 Terra</option>
      </select>
      <select id="reasoning" aria-label="Reasoning effort" title="Reasoning effort">
        <option value="auto">auto</option>
        <option value="none">none</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
      <span id="stats" class="stats" title="No requests yet">no requests yet</span>
    </div>
  </header>
  <main class="main">
    <div id="empty" class="empty" aria-hidden="true">
      <div class="empty-icon"><span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 2.5V12A2 2 0 0 1 4 10z"/><path d="M16.5 8H18a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5v2.5L14 16h-2"/></svg></span></div>
      <h2>Ask about your code</h2>
      <p>Select code in the editor, then ask GPT 6 Astra to explain, fix, or build.</p>
    </div>
    <div id="messages" class="messages" role="log" aria-live="polite" aria-label="Conversation"></div>
  </main>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <footer id="composer" class="composer">
    <div id="attachment-chips" class="attachment-chips" hidden></div>
    <div class="composer-box">
      <div class="composer-tools">
        <button id="attach" class="icon-btn" type="button" aria-label="Attach a file" aria-haspopup="menu" aria-expanded="false" title="Attach">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 11.5l-7.6 7.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.6-7.6"/></svg></span>
        </button>
        <div id="attach-menu" class="menu" role="menu" aria-label="Attach" hidden>
          <button id="attach-file" type="button" role="menuitem">
            <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg></span>
            Add file…
          </button>
          <button id="attach-path" type="button" role="menuitem">
            <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 2.5V12A2 2 0 0 1 4 10z"/><path d="M16.5 8H18a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5v2.5L14 16h-2"/></svg></span>
            Add path…
          </button>
        </div>
      </div>
      <textarea id="input" rows="1" placeholder="Ask about your code..." aria-label="Message"></textarea>
      <div class="composer-actions">
        <button id="stop" class="icon-btn" type="button" aria-label="Stop generating" title="Stop" hidden disabled>
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></span>
        </button>
        <button id="send" class="send-btn" type="button" aria-label="Send message" title="Send">
          <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg></span>
        </button>
      </div>
    </div>
    <div class="composer-hint">Enter to send · Shift+Enter for a new line</div>
  </footer>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="chat-drawer" class="drawer" role="dialog" aria-label="Chats" aria-hidden="true">
    <div class="drawer-head">
      <div>
        <h2>Chats</h2>
        <p class="drawer-sub">Your conversations</p>
      </div>
      <button id="chat-drawer-close" class="icon-btn" type="button" aria-label="Close chats" title="Close">
        <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></span>
      </button>
    </div>
    <button id="drawer-newchat" class="primary-btn" type="button">
      <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg></span>
      New chat
    </button>
    <div id="chats-list" class="chats-list"></div>
  </aside>
  <aside id="tokens-panel" class="panel" role="dialog" aria-label="Token usage" aria-hidden="true">
    <div class="panel-head">
      <h2>Tokens</h2>
      <button id="tokens-close" class="icon-btn" type="button" aria-label="Close token usage" title="Close">
        <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></span>
      </button>
    </div>
    <div id="tokens-content" class="panel-body"></div>
  </aside>
  <aside id="context-panel" class="panel" role="dialog" aria-label="Context usage" aria-hidden="true">
    <div class="panel-head">
      <h2>Context</h2>
      <button id="context-close" class="icon-btn" type="button" aria-label="Close context usage" title="Close">
        <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></span>
      </button>
    </div>
    <div id="context-content" class="panel-body"></div>
  </aside>
  <div id="confirm" class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-text" hidden>
    <div class="modal-box">
      <h2 id="confirm-text">Delete this chat?</h2>
      <p class="modal-note">This action cannot be undone.</p>
      <div class="modal-actions">
        <button id="confirm-cancel" class="ghost-btn" type="button">Cancel</button>
        <button id="confirm-ok" class="danger-btn" type="button">Delete</button>
      </div>
    </div>
  </div>
  <div id="toasts" class="toasts" role="status" aria-live="polite" aria-atomic="true"></div>
  <script nonce="${nonce}" src="${js}"></script>
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

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    const parent = path.dirname(value);
    if (parent === value) {
      return value;
    }
    return path.join(canonicalPath(parent), path.basename(value));
  }
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function resolveWorkspaceTarget(rawPath: string, roots: string[]): string | null {
  if (!rawPath) {
    return null;
  }
  const usableRoots = roots.filter((root) => Boolean(root));
  const allowed = usableRoots.map((root) =>
    normalizeForCompare(canonicalPath(path.resolve(root)))
  );
  const candidates: string[] = [];
  if (path.isAbsolute(rawPath)) {
    candidates.push(rawPath);
  }
  for (const root of usableRoots) {
    candidates.push(path.join(root, rawPath));
  }
  for (const candidate of candidates) {
    const resolved = canonicalPath(path.resolve(candidate));
    const normalized = normalizeForCompare(resolved);
    if (
      allowed.some(
        (root) => normalized === root || normalized.startsWith(root + path.sep)
      )
    ) {
      return resolved;
    }
  }
  return null;
}

async function applyWorkspaceFile(rawPath: string, content: string): Promise<boolean> {
  if (!rawPath) {
    return false;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage('AI Assistant: open a folder to create files.');
    return false;
  }

  const target = resolveWorkspaceTarget(rawPath, [folder.uri.fsPath]);
  if (!target) {
    void vscode.window.showWarningMessage(
      `AI Assistant: refusing to write outside the workspace: ${rawPath}`
    );
    return false;
  }

  try {
    const exists = fs.existsSync(target);
    const action = exists ? 'Overwrite' : 'Create';
    const choice = await vscode.window.showWarningMessage(
      exists ? `${target} already exists. Overwrite it?` : `Create ${target}?`,
      action,
      'Cancel'
    );
    if (choice !== action) {
      return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    output?.appendLine(`[AI Assistant] applied file: ${target}`);
    void vscode.window
      .showInformationMessage(`Saved ${rawPath}`, 'Open')
      .then((openChoice) => {
        if (openChoice === 'Open') {
          void openWorkspaceFile(rawPath, target);
        }
      });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output?.appendLine(`[AI Assistant] apply file failed: ${message}`);
    void vscode.window.showErrorMessage(`AI Assistant: cannot write ${rawPath}: ${message}`);
    return false;
  }
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

async function insertIntoEditor(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('AI Assistant: open a file to insert the answer.');
    return false;
  }
  return editor.edit((builder) => builder.replace(editor.selection, text));
}

function installBackendDependencies(context: vscode.ExtensionContext): void {
  const root = resolveBackendRoot(context);
  const requirements = path.join(root, 'requirements.txt');
  if (!fs.existsSync(requirements)) {
    void vscode.window.showWarningMessage(
      `AI Assistant: requirements.txt not found in ${root}.`
    );
    return;
  }
  const python = cfg().get<string>('pythonPath', 'python');
  const terminal = vscode.window.createTerminal({
    name: 'AI Assistant: backend dependencies',
  });
  terminal.show();
  terminal.sendText(`"${python}" -m pip install -r "${requirements}"`);
  void vscode.window.showInformationMessage(
    'Installing Python dependencies in the terminal. Reload VS Code when it finishes.'
  );
}

async function runSetupWizard(context: vscode.ExtensionContext): Promise<void> {
  const current = cfg();
  const providerPick = await vscode.window.showQuickPick(
    [
      { label: 'Auto', description: 'DeepSeek if a key is set, otherwise free', value: 'auto' },
      { label: 'GPT 6 Astra', description: 'DeepSeek persona with tools and file editing', value: 'deepseek' },
      { label: 'GPT 5.6 Terra', description: 'Free provider with no conversation memory', value: 'free' },
    ],
    { title: 'AI Assistant: provider', placeHolder: `Current: ${current.get('provider', 'auto')}` }
  );
  if (!providerPick) {
    return;
  }
  const model = await vscode.window.showQuickPick(['deepseek-flash', 'deepseek-v4-pro'], {
    title: 'AI Assistant: DeepSeek model',
    placeHolder: `Current: ${current.get('model', 'deepseek-flash')}`,
  });
  if (!model) {
    return;
  }
  const freeProvider = await vscode.window.showQuickPick(
    [
      'freedeepseek',
      'google',
      'gemini',
      'openrouter',
      'groq',
      'ollama',
      'pollinations',
      'openai',
    ],
    {
      title: 'AI Assistant: free provider',
      placeHolder: `Current: ${current.get('freeProvider', 'freedeepseek')}`,
    }
  );
  if (!freeProvider) {
    return;
  }
  const effort = await vscode.window.showQuickPick(['auto', 'none', 'low', 'medium', 'high'], {
    title: 'AI Assistant: reasoning level',
    placeHolder: `Current: ${current.get('reasoningEffort', 'medium')}`,
  });
  if (!effort) {
    return;
  }

  const envFile = configEnvFile(context);
  const projectRoot = resolveBackendRoot(context);
  const existing = fs.existsSync(envFile) ? readEnvFile(envFile) : readDotEnv(projectRoot);
  const storedDeepseekKey = await context.secrets.get('aiAssistant.deepseekApiKey');
  const storedFreeKey = await context.secrets.get('aiAssistant.freeApiKey');

  const deepseekKey = await vscode.window.showInputBox({
    title: 'DeepSeek API key',
    prompt: 'Leave empty to keep the current key',
    password: true,
    ignoreFocusOut: true,
  });
  if (deepseekKey === undefined) {
    return;
  }
  const freeKey = await vscode.window.showInputBox({
    title: 'Free provider API key',
    prompt: 'Leave empty to keep the current key',
    password: true,
    ignoreFocusOut: true,
  });
  if (freeKey === undefined) {
    return;
  }
  const authInput = await vscode.window.showInputBox({
    title: 'Local auth token',
    prompt: 'Leave empty to keep the current token',
    password: true,
    ignoreFocusOut: true,
  });
  if (authInput === undefined) {
    return;
  }
  const pythonPath = await vscode.window.showInputBox({
    title: 'Python executable',
    value: current.get('pythonPath', 'python'),
    ignoreFocusOut: true,
  });
  if (pythonPath === undefined) {
    return;
  }
  const backendRoot = await vscode.window.showInputBox({
    title: 'Backend folder',
    prompt: 'Leave empty to use the backend bundled with the extension',
    value: current.get('backendRoot', ''),
    ignoreFocusOut: true,
  });
  if (backendRoot === undefined) {
    return;
  }
  const contextLimit = await vscode.window.showInputBox({
    title: 'Context window limit (tokens)',
    value: String(current.get('contextLimit', 1000000)),
    ignoreFocusOut: true,
    validateInput: (value) => (/^\d+$/.test(value.trim()) ? undefined : 'Enter a positive number'),
  });
  if (contextLimit === undefined) {
    return;
  }

  const effectiveDeepseekKey =
    deepseekKey.trim() || storedDeepseekKey || existing.DEEPSEEK_API_KEY || '';
  const effectiveFreeKey = freeKey.trim() || storedFreeKey || existing.FREE_API_KEY || '';
  const effectiveAuth =
    authInput.trim() || current.get<string>('authToken', '') || existing.AUTH_TOKEN || '';
  const limit = Math.max(Number(contextLimit) || 1000000, 1);

  await current.update('provider', providerPick.value, vscode.ConfigurationTarget.Global);
  await current.update('model', model, vscode.ConfigurationTarget.Global);
  await current.update('freeProvider', freeProvider, vscode.ConfigurationTarget.Global);
  await current.update('reasoningEffort', effort, vscode.ConfigurationTarget.Global);
  await current.update('pythonPath', pythonPath.trim() || 'python', vscode.ConfigurationTarget.Global);
  await current.update('backendRoot', backendRoot.trim(), vscode.ConfigurationTarget.Global);
  await current.update('contextLimit', limit, vscode.ConfigurationTarget.Global);
  if (effectiveAuth) {
    await current.update('authToken', effectiveAuth, vscode.ConfigurationTarget.Global);
  }
  if (deepseekKey.trim()) {
    await context.secrets.store('aiAssistant.deepseekApiKey', deepseekKey.trim());
  }
  if (freeKey.trim()) {
    await context.secrets.store('aiAssistant.freeApiKey', freeKey.trim());
  }

  writeEnvFile(envFile, {
    DEEPSEEK_API_KEY: effectiveDeepseekKey,
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: model,
    PROVIDER: providerPick.value,
    FREE_PROVIDER: freeProvider,
    FREE_API_KEY: effectiveFreeKey,
    REASONING_EFFORT: effort,
    CONTEXT_LIMIT: String(limit),
    ASSISTANT_NAME: 'GPT 6 Astra',
    AUTH_TOKEN: effectiveAuth,
    HOST: '127.0.0.1',
    PORT: String(current.get('port', 8765)),
  });

  void vscode.window.showInformationMessage(
    'AI Assistant settings saved. Restarting the local backend...'
  );
  stopBackend();
  try {
    await startBackend(context);
    await ensureFreeProxy();
  } catch (err) {
    reportError('restart after setup', err);
  }
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