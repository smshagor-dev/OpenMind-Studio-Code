const vscode = require('vscode');

let output;

function activate(context) {
  output = vscode.window.createOutputChannel('Sample Command');
  output.appendLine('sample-command activated');
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleCommand.hello', async () => {
      output.appendLine('sampleCommand.hello ran');
      vscode.window.showInformationMessage('Hello from the sample command extension');
      return 'hello';
    }),
  );
}

function deactivate() {
  if (output) output.appendLine('sample-command deactivated');
}

module.exports = { activate, deactivate };
