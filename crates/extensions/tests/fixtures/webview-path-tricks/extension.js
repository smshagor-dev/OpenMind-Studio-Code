const vscode = require('vscode');

// Every address here must be refused by asWebviewUri; the command returns what happened to each one.
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewTricks.run', () => {
      const panel = vscode.window.createWebviewPanel('sampleTricks', 'Path Tricks', vscode.ViewColumn.One, {});
      const results = {};
      const attempt = (name, make) => {
        try {
          results[name] = 'allowed: ' + panel.webview.asWebviewUri(make()).toString();
        } catch (error) {
          results[name] = 'blocked: ' + error.message;
        }
      };
      const ext = context.extensionUri;
      attempt('parent', () => vscode.Uri.joinPath(ext, '..', 'other.png'));
      attempt('encoded', () => vscode.Uri.file(context.extensionPath + '/%2e%2e/other.png'));
      attempt('unc', () => vscode.Uri.file('\\server\share\a.png'));
      attempt('uncSlashes', () => vscode.Uri.file('//server/share/a.png'));
      attempt('http', () => vscode.Uri.parse('https://example.com/a.png'));
      attempt('data', () => vscode.Uri.parse('data:image/png;base64,AAAA'));
      attempt('javascript', () => vscode.Uri.parse('javascript:alert(1)'));
      attempt('inside', () => vscode.Uri.joinPath(ext, 'media', 'logo.png'));
      return results;
    }),
  );
}

module.exports = { activate };
