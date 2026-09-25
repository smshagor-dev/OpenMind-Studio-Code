const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleThrows.run', () => {
      throw new Error('boom from the command');
    }),
  );
}

module.exports = { activate };
