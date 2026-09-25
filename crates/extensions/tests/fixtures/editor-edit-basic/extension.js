const vscode = require('vscode');

function activate(context) {
  const output = vscode.window.createOutputChannel('Sample Editor Edit');
  context.subscriptions.push(
    vscode.commands.registerCommand('sampleEdit.transform', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Sample Editor Edit: no active text editor.');
        return false;
      }
      const selections = editor.selections;
      const before = editor.document.version;
      const ok = await editor.edit((builder) => {
        for (const selection of selections) {
          if (selection.isEmpty) {
            builder.insert(selection.active, '[inserted]');
          } else {
            builder.replace(selection, editor.document.getText(selection).toUpperCase());
          }
        }
      });
      const message = `edit ${ok ? 'applied' : 'REJECTED'} (version ${before} -> ${editor.document.version}, dirty=${editor.document.isDirty})`;
      output.appendLine(message);
      vscode.window.showInformationMessage(message);
      return ok;
    }),
    vscode.commands.registerCommand('sampleEdit.workspaceEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return false;
      const edit = new vscode.WorkspaceEdit();
      const last = editor.document.lineCount - 1;
      edit.insert(editor.document.uri, editor.document.lineAt(last).range.end, '\nappended by applyEdit');
      const ok = await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`applyEdit ${ok ? 'applied' : 'REJECTED'}`);
      return ok;
    }),
  );
}

module.exports = { activate };
