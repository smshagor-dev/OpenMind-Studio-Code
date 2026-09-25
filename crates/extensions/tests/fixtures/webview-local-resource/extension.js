const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewResource.open', () => {
      const panel = vscode.window.createWebviewPanel('sampleResource', 'Local Resource Webview', vscode.ViewColumn.One, {});
      const media = (name) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
      let traversal;
      try {
        traversal = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', '..', '..', 'secret.png')).toString();
      } catch (error) {
        traversal = 'blocked: ' + error.message;
      }
      panel.webview.html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="${media('style.css')}"></head><body>
        <h1>Local files</h1><img id="logo" src="${media('logo.png')}" alt="logo"><p>Traversal: ${traversal}</p></body></html>`;
      return traversal;
    }),
  );
}

module.exports = { activate };
