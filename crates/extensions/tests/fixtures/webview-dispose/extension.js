const vscode = require('vscode');

function activate(context) {
  let panel;
  const output = vscode.window.createOutputChannel('Sample Webview Dispose');
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewDispose.open', () => {
      panel = vscode.window.createWebviewPanel('sampleDispose', 'Disposable Webview', vscode.ViewColumn.One, { enableScripts: true });
      panel.webview.html = '<!DOCTYPE html><html><body><h1>Close me</h1></body></html>';
      panel.onDidDispose(() => output.appendLine('onDidDispose fired'));
      panel.webview.onDidReceiveMessage(() => output.appendLine('message after dispose (should not happen)'));
      return 'opened';
    }),
    vscode.commands.registerCommand('sampleWebviewDispose.close', async () => {
      if (!panel) return 'no panel';
      panel.dispose();
      const after = await panel.webview.postMessage({ late: true });
      let update;
      try {
        panel.webview.html = '<p>late</p>';
        update = 'updated';
      } catch (error) {
        update = error.message;
      }
      return `postMessage after dispose: ${after}; html after dispose: ${update}`;
    }),
  );
}

module.exports = { activate };
