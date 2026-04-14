const vscode = require("vscode");
const { llm, configureLlm } = require("./utils/llm");
const MCP = require("./core/mcp");
const ReActAgent = require("./core/agent");

async function execute() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith(".vue")) {
    vscode.window.showErrorMessage("请打开Vue文件");
    return;
  }

  const code = editor.document.getText();
  let replacedCount = 0;
  let changed = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ReAct LLM处理中...",
    },
    async () => {
      const c = vscode.workspace.getConfiguration("vueI18nLlm");
      const apiKey =
        String(c.get("apiKey") || "").trim() ||
        process.env.VUE_I18N_LLM_API_KEY ||
        "";
      const baseUrl = String(c.get("baseUrl") || "").trim();
      const model = String(c.get("model") || "").trim();
      configureLlm({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
      });

      const mcp = new MCP(llm);
      await mcp.loadSkills();

      const agent = new ReActAgent(mcp);
      const result = await agent.run(code);
      const newCode = typeof result === "string" ? result : result?.code || code;
      replacedCount = typeof result === "string" ? 0 : result?.replacedCount || 0;

      if (newCode && newCode !== code) {
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(code.length),
        );
        edit.replace(editor.document.uri, range, newCode);
        changed = await vscode.workspace.applyEdit(edit);
      }
    },
  );

  if (changed) {
    vscode.window.showInformationMessage(
      `✅ 国际化处理完成，已替换 ${replacedCount} 处中文。`,
    );
  } else {
    vscode.window.showWarningMessage(
      "未检测到可替换内容，或替换结果与原文件一致。",
    );
  }
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
