const vscode = require('vscode');

// A page with two counters: "runtime" lives only in the page (lost when the page is drawn again), "saved" is kept
// with setState and read back with getState (survives being hidden and shown, not an app restart).
function page(label) {
  return `<!DOCTYPE html><html><body>
    <h2>${label}</h2>
    <button id="up">Count</button>
    <p>runtime: <b id="runtime">0</b> | saved: <b id="saved">0</b></p>
    <script>
      const vscode = acquireVsCodeApi();
      let runtime = 0;
      let saved = (vscode.getState() || { saved: 0 }).saved;
      const show = () => {
        document.getElementById('runtime').textContent = runtime;
        document.getElementById('saved').textContent = saved;
      };
      show();
      document.getElementById('up').addEventListener('click', () => {
        runtime += 1;
        saved += 1;
        vscode.setState({ saved });
        show();
      });
    </script>
  </body></html>`;
}

function activate(context) {
  const open = (viewType, title, options, label) => {
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.One, { enableScripts: true, ...options });
    panel.webview.html = page(label);
    return panel.title;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleWebviewCounter.retained', () => open('counterRetained', 'Retained Counter', { retainContextWhenHidden: true }, 'Retained')),
    vscode.commands.registerCommand('sampleWebviewCounter.plain', () => open('counterPlain', 'Plain Counter', {}, 'Plain')),
    vscode.commands.registerCommand('sampleWebviewCounter.longTitle', () =>
      open('counterLong', 'A very long webview title that has to be cut with an ellipsis in the tab strip of a narrow window', {}, 'Long title'),
    ),
  );
}

module.exports = { activate };
