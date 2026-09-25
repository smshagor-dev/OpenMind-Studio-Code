const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewRemote.open', () => {
      const results = [];
      try {
        vscode.window.createWebviewPanel('x', 'x', 1, { localResourceRoots: [vscode.Uri.file(require('os').homedir())] });
        results.push('roots: allowed');
      } catch (error) {
        results.push('roots: ' + error.message);
      }
      const panel = vscode.window.createWebviewPanel('sampleRemote', 'Remote Webview', vscode.ViewColumn.One, { enableScripts: true });
      try {
        panel.webview.asWebviewUri(vscode.Uri.file(process.env.ComSpec || '/etc/passwd'));
        results.push('asWebviewUri: allowed');
      } catch (error) {
        results.push('asWebviewUri: ' + error.message);
      }
      panel.webview.html = `<!DOCTYPE html><html><head>
        <link rel="stylesheet" href="https://example.com/remote.css"><script src="https://example.com/remote.js"></script></head>
        <body><h1>Remote content</h1><img src="https://example.com/remote.png" alt="remote"><a href="javascript:alert(1)">bad link</a>
        <iframe src="https://example.com"></iframe><img src="file:///C:/Windows/win.ini"></body></html>`;
      vscode.window.showInformationMessage(results.join(' | '));
      return results;
    }),
  );
}

module.exports = { activate };
