const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleUnsupported.run', () => {
      // Not part of the supported subset: this throws "VS Code API 'tasks.registerTaskProvider' is not supported ...".
      vscode.tasks.registerTaskProvider('sample', {});
    }),
  );
}

module.exports = { activate };
