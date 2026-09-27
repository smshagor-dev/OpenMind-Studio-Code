const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleUnsupported.run', () => {
      // Not part of the supported subset: this throws "VS Code API 'debug.startDebugging' is not supported ...".
      vscode.debug.startDebugging(undefined, 'sample');
    }),
  );
}

module.exports = { activate };
