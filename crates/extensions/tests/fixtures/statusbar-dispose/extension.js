const vscode = require('vscode');

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleStatusDispose.cycle', async () => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
      item.text = 'cycling';
      item.show();
      await pause();
      item.hide();
      await pause();
      item.show();
      await pause();
      item.dispose();
      item.text = 'updated after dispose';
      item.show();
      return 'disposed';
    }),
  );
}

module.exports = { activate };
