const vscode = require('vscode');

function activate(context) {
  const left = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  left.text = '$(rocket) Sample Status';
  left.tooltip = 'Runs sampleStatus.clicked';
  left.command = 'sampleStatus.clicked';
  left.show();

  const right = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  right.text = 'Right item with a rather long text that has to be cut with an ellipsis in a narrow window';
  right.tooltip = 'The full text is in the tooltip';
  right.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  right.show();

  let clicks = 0;
  context.subscriptions.push(
    left,
    right,
    vscode.commands.registerCommand('sampleStatus.clicked', () => {
      clicks += 1;
      left.text = `$(rocket) Clicked ${clicks}`;
      vscode.window.showInformationMessage(`Status bar item clicked (${clicks})`);
    }),
  );
}

module.exports = { activate };
