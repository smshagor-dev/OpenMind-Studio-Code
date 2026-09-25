const vscode = require('vscode');

function attempt(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => `${label}: allowed`,
      (error) => `${label}: ${error.message}`,
    );
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('samplePermission.run', async () => {
      const results = [];
      results.push(await attempt('child_process', () => require('child_process').execSync('echo hi')));
      results.push(await attempt('http', () => require('node:http')));
      results.push(await attempt('fetch', () => fetch('http://127.0.0.1:9/')));
      results.push(await attempt('fs outside', () => require('fs').readFileSync(process.env.ComSpec || '/etc/passwd')));
      results.push(await attempt('fs write', () => require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'openmind-denied.txt'), 'x')));
      results.push(await attempt('terminal', () => vscode.window.createTerminal('x')));
      results.push(await attempt('openExternal', () => vscode.env.openExternal(vscode.Uri.parse('https://example.com'))));
      results.push(await attempt('settings', () => vscode.workspace.getConfiguration('x')));
      vscode.window.showInformationMessage(results.join(" | "));
      return results;
    }),
    vscode.commands.registerCommand('samplePermission.own', () => {
      // Its own storage needs no permission.
      const file = require('path').join(context.globalStoragePath, 'note.txt');
      require('fs').writeFileSync(file, 'ok');
      return require('fs').readFileSync(file, 'utf8');
    }),
  );
}

module.exports = { activate };
