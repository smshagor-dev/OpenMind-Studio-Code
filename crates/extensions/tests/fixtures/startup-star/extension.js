const vscode = require('vscode');

function activate() {
  vscode.window.createOutputChannel('Sample Startup').appendLine('sample-star activated at startup');
}

module.exports = { activate };
