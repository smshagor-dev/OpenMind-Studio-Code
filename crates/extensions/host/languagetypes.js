'use strict';
// VS Code API value types of the language features (code actions, symbols, semantic tokens, inlay hints ...)
// and the public enums. Split out of vscode.js, which re-exports them.
const { Disposable, DiagnosticSeverity, DiagnosticTag, CompletionTriggerKind, CodeActionTriggerKind, SymbolTag, CompletionItemKind } = require('./types.js');

const publicEnumValues = {
  "TextEditorSelectionChangeKind": {
    "Keyboard": 1,
    "Mouse": 2,
    "Command": 3
  },
  "TextEditorCursorStyle": {
    "Line": 1,
    "Block": 2,
    "Underline": 3,
    "LineThin": 4,
    "BlockOutline": 5,
    "UnderlineThin": 6
  },
  "TextEditorLineNumbersStyle": {
    "Off": 0,
    "On": 1,
    "Relative": 2
  },
  "TextEditorRevealType": {
    "Default": 0,
    "InCenter": 1,
    "InCenterIfOutsideViewport": 2,
    "AtTop": 3
  },
  "OverviewRulerLane": {
    "Left": 1,
    "Center": 2,
    "Right": 4,
    "Full": 7
  },
  "DecorationRangeBehavior": {
    "OpenOpen": 0,
    "ClosedClosed": 1,
    "OpenClosed": 2,
    "ClosedOpen": 3
  },
  "EndOfLine": {
    "LF": 1,
    "CRLF": 2
  },
  "QuickPickItemKind": {
    "Separator": -1,
    "Default": 0
  },
  "InputBoxValidationSeverity": {
    "Info": 1,
    "Warning": 2,
    "Error": 3
  },
  "CodeActionTriggerKind": {
    "Invoke": 1,
    "Automatic": 2
  },
  "DocumentHighlightKind": {
    "Text": 0,
    "Read": 1,
    "Write": 2
  },
  "SymbolKind": {
    "File": 0,
    "Module": 1,
    "Namespace": 2,
    "Package": 3,
    "Class": 4,
    "Method": 5,
    "Property": 6,
    "Field": 7,
    "Constructor": 8,
    "Enum": 9,
    "Interface": 10,
    "Function": 11,
    "Variable": 12,
    "Constant": 13,
    "String": 14,
    "Number": 15,
    "Boolean": 16,
    "Array": 17,
    "Object": 18,
    "Key": 19,
    "Null": 20,
    "EnumMember": 21,
    "Struct": 22,
    "Event": 23,
    "Operator": 24,
    "TypeParameter": 25
  },
  "SymbolTag": {
    "Deprecated": 1
  },
  "SignatureHelpTriggerKind": {
    "Invoke": 1,
    "TriggerCharacter": 2,
    "ContentChange": 3
  },
  "CompletionItemKind": {
    "Text": 0,
    "Method": 1,
    "Function": 2,
    "Constructor": 3,
    "Field": 4,
    "Variable": 5,
    "Class": 6,
    "Interface": 7,
    "Module": 8,
    "Property": 9,
    "Unit": 10,
    "Value": 11,
    "Enum": 12,
    "Keyword": 13,
    "Snippet": 14,
    "Color": 15,
    "Reference": 17,
    "File": 16,
    "Folder": 18,
    "EnumMember": 19,
    "Constant": 20,
    "Struct": 21,
    "Event": 22,
    "Operator": 23,
    "TypeParameter": 24,
    "User": 25,
    "Issue": 26
  },
  "CompletionItemTag": {
    "Deprecated": 1
  },
  "CompletionTriggerKind": {
    "Invoke": 0,
    "TriggerCharacter": 1,
    "TriggerForIncompleteCompletions": 2
  },
  "InlineCompletionTriggerKind": {
    "Invoke": 0,
    "Automatic": 1
  },
  "InlayHintKind": {
    "Type": 1,
    "Parameter": 2
  },
  "FoldingRangeKind": {
    "Comment": 1,
    "Imports": 2,
    "Region": 3
  },
  "IndentAction": {
    "None": 0,
    "Indent": 1,
    "IndentOutdent": 2,
    "Outdent": 3
  },
  "SyntaxTokenType": {
    "Other": 0,
    "Comment": 1,
    "String": 2,
    "RegEx": 3
  },
  "ConfigurationTarget": {
    "Global": 1,
    "Workspace": 2,
    "WorkspaceFolder": 3
  },
  "DiagnosticSeverity": {
    "Error": 0,
    "Warning": 1,
    "Information": 2,
    "Hint": 3
  },
  "DiagnosticTag": {
    "Unnecessary": 1,
    "Deprecated": 2
  },
  "LanguageStatusSeverity": {
    "Information": 0,
    "Warning": 1,
    "Error": 2
  },
  "ViewColumn": {
    "Active": -1,
    "Beside": -2,
    "One": 1,
    "Two": 2,
    "Three": 3,
    "Four": 4,
    "Five": 5,
    "Six": 6,
    "Seven": 7,
    "Eight": 8,
    "Nine": 9
  },
  "StatusBarAlignment": {
    "Left": 1,
    "Right": 2
  },
  "TerminalLocation": {
    "Panel": 1,
    "Editor": 2
  },
  "ExtensionKind": {
    "UI": 1,
    "Workspace": 2
  },
  "ExtensionMode": {
    "Production": 1,
    "Development": 2,
    "Test": 3
  },
  "ColorThemeKind": {
    "Light": 1,
    "Dark": 2,
    "HighContrast": 3,
    "HighContrastLight": 4
  },
  "TaskRevealKind": {
    "Always": 1,
    "Silent": 2,
    "Never": 3
  },
  "TaskPanelKind": {
    "Shared": 1,
    "Dedicated": 2,
    "New": 3
  },
  "ShellQuoting": {
    "Escape": 1,
    "Strong": 2,
    "Weak": 3
  },
  "TaskScope": {
    "Global": 1,
    "Workspace": 2
  },
  "FileType": {
    "Unknown": 0,
    "File": 1,
    "Directory": 2,
    "SymbolicLink": 64
  },
  "FilePermission": {
    "Readonly": 1
  },
  "FileChangeType": {
    "Changed": 1,
    "Created": 2,
    "Deleted": 3
  },
  "UIKind": {
    "Desktop": 1,
    "Web": 2
  },
  "LogLevel": {
    "Off": 0,
    "Trace": 1,
    "Debug": 2,
    "Info": 3,
    "Warning": 4,
    "Error": 5
  },
  "TreeItemCollapsibleState": {
    "None": 0,
    "Collapsed": 1,
    "Expanded": 2
  },
  "TreeItemCheckboxState": {
    "Unchecked": 0,
    "Checked": 1
  },
  "TerminalExitReason": {
    "Unknown": 0,
    "Shutdown": 1,
    "Process": 2,
    "User": 3,
    "Extension": 4
  },
  "EnvironmentVariableMutatorType": {
    "Replace": 1,
    "Append": 2,
    "Prepend": 3
  },
  "ProgressLocation": {
    "SourceControl": 1,
    "Window": 10,
    "Notification": 15
  },
  "TextDocumentChangeReason": {
    "Undo": 1,
    "Redo": 2
  },
  "TextDocumentSaveReason": {
    "Manual": 1,
    "AfterDelay": 2,
    "FocusOut": 3
  },
  "NotebookEditorRevealType": {
    "Default": 0,
    "InCenter": 1,
    "InCenterIfOutsideViewport": 2,
    "AtTop": 3
  },
  "NotebookCellKind": {
    "Markup": 1,
    "Code": 2
  },
  "NotebookControllerAffinity": {
    "Default": 1,
    "Preferred": 2
  },
  "NotebookCellStatusBarAlignment": {
    "Left": 1,
    "Right": 2
  },
  "DebugConsoleMode": {
    "Separate": 0,
    "MergeWithParent": 1
  },
  "DebugConfigurationProviderTriggerKind": {
    "Initial": 1,
    "Dynamic": 2
  },
  "CommentThreadCollapsibleState": {
    "Collapsed": 0,
    "Expanded": 1
  },
  "CommentMode": {
    "Editing": 0,
    "Preview": 1
  },
  "CommentThreadState": {
    "Unresolved": 0,
    "Resolved": 1
  },
  "TestRunProfileKind": {
    "Run": 1,
    "Debug": 2,
    "Coverage": 3
  }
};
const publicEnums = Object.fromEntries(Object.entries(publicEnumValues).map(([name, values]) => {
  const result = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return [name, Object.freeze(result)];
}));

const ColorThemeKind = Object.freeze({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 });
const UIKind = Object.freeze({ Desktop: 1, Web: 2 });
const QuickInputButtons = Object.freeze({ Back: Object.freeze({ iconPath: undefined, tooltip: 'Back' }) });

class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
}
class CallHierarchyIncomingCall { constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); } }
class CallHierarchyOutgoingCall { constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); } }
class TypeHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
}
class InlineCompletionItem {
  constructor(insertText, range, command) { this.insertText = insertText; this.range = range; this.command = command; }
}
class InlineCompletionList {
  constructor(items) { this.items = items; }
}
const InlineCompletionTriggerKind = Object.freeze({ Invoke: 0, Automatic: 1 });

class Color {
  constructor(red, green, blue, alpha) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha; }
}
class ColorInformation {
  constructor(range, color) { this.range = range; this.color = color; }
}
class ColorPresentation {
  constructor(label) { this.label = label; }
}
class InlayHintLabelPart {
  constructor(value) { this.value = value; }
}
class InlayHint {
  constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; }
}
const InlayHintKind = Object.freeze({ Type: 1, Parameter: 2 });

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers = []) { this.tokenTypes = [...tokenTypes]; this.tokenModifiers = [...tokenModifiers]; }
}
class SemanticTokens {
  constructor(data, resultId) { this.data = data; this.resultId = resultId; }
}
class SemanticTokensEdit {
  constructor(start, deleteCount, data) { this.start = start; this.deleteCount = deleteCount; this.data = data; }
}
class SemanticTokensEdits {
  constructor(edits, resultId) { this.edits = edits; this.resultId = resultId; }
}
class SemanticTokensBuilder {
  constructor(legend) { this.legend = legend; this.tokens = []; }
  push(line, char, length, tokenType, tokenModifiers = 0) {
    if (typeof line === 'object') {
      const range = line;
      if (!this.legend || range.start.line !== range.end.line) throw new Error('Named semantic tokens require a legend and a single-line range.');
      const type = this.legend.tokenTypes.indexOf(char);
      if (type < 0) throw new Error('Unknown semantic token type.');
      let modifiers = 0;
      for (const name of length || []) {
        const index = this.legend.tokenModifiers.indexOf(name);
        if (index < 0 || index >= 32) throw new Error('Unknown semantic token modifier.');
        modifiers = (modifiers | (1 << index)) >>> 0;
      }
      return this.push(range.start.line, range.start.character, range.end.character - range.start.character, type, modifiers);
    }
    if (![line, char, length, tokenType, tokenModifiers].every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) || length === 0) throw new Error('Invalid semantic token.');
    this.tokens.push([line, char, length, tokenType, tokenModifiers]);
  }
  build(resultId) {
    const data = []; let line = 0; let char = 0;
    for (const token of [...this.tokens].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      data.push(token[0] - line, token[0] === line ? token[1] - char : token[1], ...token.slice(2));
      [line, char] = token;
    }
    return new SemanticTokens(new Uint32Array(data), resultId);
  }
}

class CodeActionKind {
  constructor(value = '') { this.value = value; }
  append(part) { return new CodeActionKind(this.value ? this.value + '.' + part : part); }
  contains(other) {
    const value = other instanceof CodeActionKind ? other.value : String(other);
    return !this.value || value === this.value || value.startsWith(this.value + '.');
  }
  intersects(other) {
    const value = other instanceof CodeActionKind ? other.value : String(other);
    return this.contains(value) || new CodeActionKind(value).contains(this);
  }
}
CodeActionKind.Empty = new CodeActionKind('');
CodeActionKind.QuickFix = new CodeActionKind('quickfix');
CodeActionKind.Refactor = new CodeActionKind('refactor');
CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
CodeActionKind.Source = new CodeActionKind('source');
CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() { return this.command !== undefined; }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
  Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

class SymbolInformation {
  constructor(name, kind, containerName, location) {
    this.name = name;
    this.kind = kind;
    if (typeof containerName === 'string') {
      this.containerName = containerName;
      this.location = location;
    } else {
      this.containerName = '';
      this.location = containerName;
    }
  }
}

class FoldingRange {
  constructor(start, end, kind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}
const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };

const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
class DocumentHighlight {
  constructor(range, kind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

class SelectionRange {
  constructor(range, parent) {
    if (parent && !parent.range.contains(range)) throw new Error('A selection range parent must contain its child.');
    this.range = range; this.parent = parent;
  }
}
class LinkedEditingRanges { constructor(ranges, wordPattern) { this.ranges = ranges; this.wordPattern = wordPattern; } }
class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}
class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
    this.activeParameter = 0;
  }
}
class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };

module.exports = { publicEnumValues, publicEnums, ColorThemeKind, UIKind, QuickInputButtons, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem, InlineCompletionItem, InlineCompletionList, InlineCompletionTriggerKind, Color, ColorInformation, ColorPresentation, InlayHintLabelPart, InlayHint, InlayHintKind, SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder, CodeActionKind, CodeAction, CodeLens, DocumentLink, SymbolKind, DocumentSymbol, SymbolInformation, FoldingRange, FoldingRangeKind, DocumentHighlightKind, DocumentHighlight, SelectionRange, LinkedEditingRanges, ParameterInformation, SignatureInformation, SignatureHelp, ConfigurationTarget, ViewColumn };
