const vscode = require("vscode");
const { llm } = require("./utils/llm");
const MCP = require("./core/mcp");
const ReActAgent = require("./core/agent");

async function execute() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith(".vue")) {
    vscode.window.showErrorMessage("请打开Vue文件");
    return;
  }

  const code = editor.document.getText();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ReAct LLM处理中...",
    },
    async () => {
      const mcp = new MCP(llm);
      await mcp.loadSkills();

      const agent = new ReActAgent(mcp);
      const newCode = await agent.run(code);

      if (newCode && newCode !== code) {
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(code.length),
        );
        edit.replace(editor.document.uri, range, newCode);
        await vscode.workspace.applyEdit(edit);
      }
    },
  );

  vscode.window.showInformationMessage("✅ 国际化处理完成！");
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vue-i18n-llm-plugin.translateAll",
      execute,
    ),
  );
}

module.exports = { activate, deactivate: () => {} };
