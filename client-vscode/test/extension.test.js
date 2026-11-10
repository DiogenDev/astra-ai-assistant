const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

function createVscodeMock() {
  const disposable = { dispose() {} };
  const outputChannel = { append() {}, appendLine() {}, show() {}, dispose() {} };
  const config = {
    autoStartFreeAi: false,
    autoStartBackend: true,
    provider: 'free',
  };

  return {
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    InlineCompletionTriggerKind: { Automatic: 1 },
    workspace: {
      isTrusted: false,
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
        update: async () => {},
      }),
      onDidChangeTextDocument: () => disposable,
      asRelativePath: (uri) => uri.fsPath || String(uri),
      openTextDocument: async () => ({}),
    },
    window: {
      createOutputChannel: () => outputChannel,
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showTextDocument: async () => ({}),
      onDidChangeActiveTextEditor: () => disposable,
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: () => disposable,
      executeCommand: async () => undefined,
    },
    languages: {
      registerInlineCompletionItemProvider: () => disposable,
    },
    env: {
      openExternal: async () => true,
      clipboard: { writeText: async () => undefined },
    },
    Uri: {
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath || '', ...parts) }),
      file: (fsPath) => ({ fsPath }),
      parse: (value) => ({ toString: () => value }),
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
  };
}

function loadExtension() {
  const vscodeMock = createVscodeMock();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const entry = require.resolve('../out/extension.js');
    delete require.cache[entry];
    return require(entry);
  } finally {
    Module._load = originalLoad;
  }
}

test('extension loads, activates and deactivates without throwing', async () => {
  const extension = loadExtension();
  const context = {
    subscriptions: [],
    extensionPath: path.resolve(__dirname, '..'),
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    globalStorageUri: { fsPath: path.join(os.tmpdir(), 'astra-global-storage') },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    globalState: {
      get: (key, fallback) => (key === 'aiAssistant.welcomed' ? true : fallback),
      update: async () => {},
    },
  };

  await extension.activate(context);
  assert.ok(context.subscriptions.length > 0);
  extension.deactivate();
});

test('resolveWorkspaceTarget enforces the workspace root', () => {
  const extension = loadExtension();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-workspace-'));

  try {
    const realRoot = fs.realpathSync(root);
    assert.equal(
      extension.resolveWorkspaceTarget('src/app.py', [root]),
      path.join(realRoot, 'src', 'app.py')
    );
    assert.equal(extension.resolveWorkspaceTarget('../evil.py', [root]), null);
    const absolute = path.join(realRoot, 'absolute.py');
    assert.equal(extension.resolveWorkspaceTarget(absolute, [root]), absolute);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkspaceTarget blocks symlink/junction escapes', (t) => {
  const extension = loadExtension();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-outside-'));

  try {
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink creation is not permitted');
      return;
    }
    assert.equal(extension.resolveWorkspaceTarget('link/evil.txt', [root]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
