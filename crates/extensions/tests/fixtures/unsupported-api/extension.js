const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleUnsupported.run', () => {
      // Tracker factories remain outside the supported debug adapter subset.
      vscode.debug.registerDebugAdapterTrackerFactory('sample', {});
    }),
  );
}

module.exports = { activate };

