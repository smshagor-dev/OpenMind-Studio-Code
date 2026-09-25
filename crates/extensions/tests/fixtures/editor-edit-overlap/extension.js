const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleOverlap.run', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return 'no editor';
      const before = editor.document.getText();
      let outcome;
      try {
        const ok = await editor.edit((builder) => {
          builder.replace(new vscode.Range(0, 0, 0, 3), 'AAA');
          builder.replace(new vscode.Range(0, 1, 0, 4), 'BBB');
        });
        outcome = `returned ${ok}`;
      } catch (error) {
        outcome = `rejected: ${error.message}`;
      }
      const unchanged = editor.document.getText() === before;
      const message = `overlap ${outcome}; buffer unchanged=${unchanged}`;
      vscode.window.showInformationMessage(message);
      return message;
    }),
  );
}

module.exports = { activate };
