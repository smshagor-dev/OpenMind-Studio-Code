const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('sampleDuplicate.run', () => { vscode.window.showInformationMessage(globalThis.duplicateError || 'no error'); return 'duplicate ran'; }));
  // Already registered by the command-basic sample: this must fail clearly and not replace it.
  try {
    vscode.commands.registerCommand('sampleCommand.hello', () => 'stolen');
  } catch (error) {
    globalThis.duplicateError = error.message;
  }
  context.subscriptions.push(vscode.commands.registerCommand('sampleDuplicate.error', () => globalThis.duplicateError || null));
  try {
    vscode.commands.registerCommand('sampleDuplicate.run', () => 'again');
  } catch (error) {
    globalThis.selfDuplicateError = error.message;
  }
  context.subscriptions.push(vscode.commands.registerCommand('sampleDuplicate.selfError', () => globalThis.selfDuplicateError || null));
}

module.exports = { activate };
