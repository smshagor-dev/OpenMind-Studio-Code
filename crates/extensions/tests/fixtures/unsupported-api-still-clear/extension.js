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
    vscode.commands.registerCommand('sampleStillUnsupported.run', () => {
      const results = [
        attempt('inputBox', () => vscode.window.createInputBox()),
        attempt('decorations', () => vscode.window.createTextEditorDecorationType({})),
        attempt('debug', () => vscode.debug.registerDebugAdapterTrackerFactory('x', {})),
        attempt('notebook', () => vscode.notebooks.registerNotebookCellStatusBarItemProvider('x', {})),
        attempt('createFile', () => new vscode.WorkspaceEdit().createFile(vscode.Uri.file('x'))),
      ];
      vscode.window.showInformationMessage(results.join(' | '));
      return results;
    }),
  );
}

module.exports = { activate };

