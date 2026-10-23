const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleUnsupported.run', () => {
      // Virtual debug source URIs remain outside the supported debug subset.
      vscode.debug.asDebugSourceUri({ sourceReference: 1 });
    }),
  );
}

module.exports = { activate };

