const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleUnsupported.run', () => {
      // Notebook cell status bar items remain outside the supported API subset.
      vscode.notebooks.registerNotebookCellStatusBarItemProvider('x', {});
    }),
  );
}

module.exports = { activate };

