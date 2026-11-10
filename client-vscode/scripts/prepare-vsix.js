const fs = require('node:fs');
const path = require('node:path');

const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..');
const sourceBackend = path.join(repoRoot, 'backend');
const targetBackend = path.join(clientRoot, 'backend');

fs.rmSync(targetBackend, { recursive: true, force: true });
fs.cpSync(sourceBackend, targetBackend, {
  recursive: true,
  filter: (source) => !source.includes('__pycache__') && !source.endsWith('.pyc'),
});
fs.copyFileSync(
  path.join(repoRoot, 'requirements.txt'),
  path.join(clientRoot, 'requirements.txt')
);

console.log('Bundled backend and requirements.txt for the VSIX.');
