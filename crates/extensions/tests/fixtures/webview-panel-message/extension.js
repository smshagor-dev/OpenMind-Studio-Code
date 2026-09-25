const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewMessage.open', () => {
      const panel = vscode.window.createWebviewPanel('sampleMessage', 'Message Webview', vscode.ViewColumn.One, { enableScripts: true });
      panel.webview.onDidReceiveMessage(async (message) => {
        vscode.window.showInformationMessage(`Extension got: ${JSON.stringify(message)}`);
        await panel.webview.postMessage({ reply: 'pong ' + message.count });
      });
      panel.webview.html = `<!DOCTYPE html><html><body>
        <button id="ping">Send ping</button>
        <p id="out">waiting</p>
        <script>
          const vscode = acquireVsCodeApi();
          let count = 0;
          document.getElementById('ping').addEventListener('click', () => { count += 1; vscode.postMessage({ command: 'ping', count }); });
          window.addEventListener('message', (event) => { document.getElementById('out').textContent = 'Reply: ' + event.data.reply; });
        </script>
      </body></html>`;
    }),
  );
}

module.exports = { activate };
