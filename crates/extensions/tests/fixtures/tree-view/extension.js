const vscode = require('vscode');

const tasks = [];

class TaskProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  getChildren(element) {
    if (!element) return tasks;
    return element.steps.map((step) => ({ step, parent: element }));
  }
  getTreeItem(element) {
    if (element.step) {
      const item = new vscode.TreeItem(element.step, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('circle-outline');
      return item;
    }
    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${element.steps.length} steps`;
    item.tooltip = `Task: ${element.title}`;
    item.iconPath = vscode.Uri.file(require('path').join(__dirname, 'media', 'tasks.svg'));
    item.command = { command: 'sampleTasks.open', title: 'Open', arguments: [element.title] };
    return item;
  }
}

function activate(context) {
  const provider = new TaskProvider();
  const view = vscode.window.createTreeView('sampleTasks.list', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('sampleTasks.add', () => {
      const n = tasks.length + 1;
      tasks.push({ title: `Task ${n}`, steps: ['Plan', 'Build'] });
      provider.changed.fire();
      view.description = `${tasks.length} open`;
      return n;
    }),
    vscode.commands.registerCommand('sampleTasks.open', (title) => {
      vscode.window.showInformationMessage(`Opened ${title}`);
      return title;
    }),
    vscode.commands.registerCommand('sampleTasks.clear', () => {
      tasks.splice(0);
      provider.changed.fire();
      view.description = undefined;
    }),
  );
}

module.exports = { activate };
