const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
);

test('manifest: activation events are minimal', () => {
  assert.deepEqual(pkg.activationEvents, ['onStartupFinished']);
});

test('manifest: commands are declared', () => {
  const commands = pkg.contributes.commands.map((command) => command.command);
  for (const expected of [
    'aiAssistant.openChat',
    'aiAssistant.explainSelection',
    'aiAssistant.fixSelection',
    'aiAssistant.runInlineRequest',
    'aiAssistant.setup',
    'aiAssistant.installDeps',
  ]) {
    assert.ok(commands.includes(expected), expected);
  }
});

test('manifest: view container and chat view are declared', () => {
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'aiAssistant');
  assert.equal(pkg.contributes.views.aiAssistant[0].id, 'aiAssistant.chatView');
});

test('manifest: expected settings are present', () => {
  const properties = pkg.contributes.configuration.properties;
  for (const key of [
    'aiAssistant.provider',
    'aiAssistant.autoStartBackend',
    'aiAssistant.autoStartFreeAi',
    'aiAssistant.freeDeepseekRoot',
    'aiAssistant.nodePath',
    'aiAssistant.autoApplyFiles',
    'aiAssistant.reasoningEffort',
    'aiAssistant.inlineRequest.enabled',
    'aiAssistant.inlineRequest.auto',
    'aiAssistant.inlineRequest.idleDelayMs',
  ]) {
    assert.ok(properties[key], key);
  }
});

test('manifest: entrypoint and engine are valid', () => {
  assert.equal(pkg.main, './out/extension.js');
  assert.ok(pkg.engines.vscode);
  assert.ok(pkg.devDependencies['@types/vscode']);
  assert.ok(pkg.devDependencies.jsdom);
});

test('launch preLaunchTask uses the npm.cmd build task', () => {
  const root = path.resolve(__dirname, '..');
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'launch.json'), 'utf8'));
  const tasks = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'tasks.json'), 'utf8'));
  const label = launch.configurations[0].preLaunchTask;
  const task = tasks.tasks.find((candidate) => candidate.label === label);
  assert.ok(task, `missing task: ${label}`);
  assert.equal(task.command, 'npm.cmd');
  assert.deepEqual(task.args, ['run', 'compile']);
});

test('manifest: @types/vscode minimum is not newer than engines.vscode', () => {
  const min = (range) => {
    const match = String(range).match(/(\d+\.\d+)/);
    return match ? Number(match[1].split('.')[0]) * 1000 + Number(match[1].split('.')[1]) : 0;
  };
  assert.ok(min(pkg.devDependencies['@types/vscode']) <= min(pkg.engines.vscode));
});
