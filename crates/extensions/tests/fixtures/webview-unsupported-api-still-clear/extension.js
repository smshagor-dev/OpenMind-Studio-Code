const vscode = require('vscode');

function attempt(label, fn) {
  try {
    fn();
    return `${label}: allowed`;
  } catch (error) {
    return `${label}: ${error.message}`;
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewUnsupported.run', async () => {
      const results = [
        attempt('commandUris', () => vscode.window.createWebviewPanel('a', 'A', 1, { enableCommandUris: true })),
        attempt('portMapping', () => vscode.window.createWebviewPanel('a', 'A', 1, { portMapping: [{ webviewPort: 1, extensionHostPort: 2 }] })),
        attempt('serializer', () => vscode.window.registerWebviewPanelSerializer('a', {})),
        attempt('webviewView', () => vscode.window.registerWebviewViewProvider('a', {})),
      ];
      try {
        await vscode.window.createWebviewPanel('a', 'A', 1, {}).webview.postMessage(() => 1);
        results.push('nonJson: allowed');
      } catch (error) {
        results.push(`nonJson: ${error.message}`);
      }
      vscode.window.showInformationMessage(results.join(' | '));
      return results;
    }),
  );
}

module.exports = { activate };
