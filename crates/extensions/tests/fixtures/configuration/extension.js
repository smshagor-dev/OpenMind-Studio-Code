const vscode = require('vscode');

function activate(context) {
  const output = vscode.window.createOutputChannel('Sample Configuration');
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleConfig.show', () => {
      const config = vscode.workspace.getConfiguration('sampleConfig');
      const greeting = config.get('greeting');
      output.appendLine(`greeting=${greeting} count=${config.get('count')}`);
      vscode.window.showInformationMessage(`sampleConfig.greeting = ${greeting}`);
      return greeting;
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sampleConfig')) output.appendLine('sampleConfig changed');
    }),
  );
}

module.exports = { activate };
