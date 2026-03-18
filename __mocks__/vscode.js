// __mocks__/vscode.js
const sinon = require("sinon");

// 模拟 VS Code 核心常量/类
const vscode = {
  // 窗口相关 API
  window: {
    activeTextEditor: null,
    showErrorMessage: sinon.stub(),
    showInformationMessage: sinon.stub(),
    showWarningMessage: sinon.stub(),
  },
  // 工作区相关 API
  workspace: {
    workspaceFolders: null,
  },
  // 命令相关 API
  commands: {
    registerCommand: sinon.stub().returns({ dispose: sinon.stub() }),
  },
  // 编辑器相关类
  Selection: class Selection {
    constructor(startLine, startChar, endLine, endChar) {
      this.startLine = startLine;
      this.startChar = startChar;
      this.endLine = endLine;
      this.endChar = endChar;
    }
  },
  Range: class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Position: class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
    with(obj) {
      return new vscode.Position(
        obj.line || this.line,
        obj.character || this.character,
      );
    }
  },
  ViewColumn: {
    One: 1,
  },
  EndOfLine: {
    LF: 1,
  },
};

module.exports = vscode;
