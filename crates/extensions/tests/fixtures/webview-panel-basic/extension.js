const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebview.basic', () => {
      const panel = vscode.window.createWebviewPanel('sampleBasic', 'Basic Webview', vscode.ViewColumn.One, {});
      panel.webview.html =
        '<!DOCTYPE html><html><body><h1 id="title">Hello from a webview</h1><p>Scripts are off.</p>' +
        '<script>document.getElementById("title").textContent = "SCRIPT RAN";</script>' +
        '<button onclick="document.title=1">inline handler</button></body></html>';
      return panel.title;
    }),
  );
}

module.exports = { activate };
