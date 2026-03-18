const path = require("path");
const mockVscodePath = path.join(__dirname, "../../__mocks__/vscode.js");
require(mockVscodePath);

const assert = require("assert");
const vscode = require("vscode");
const fs = require("fs-extra");
const axios = require("axios");
const sinon = require("sinon");
const { activate, deactivate } = require("../extension");

// 全局测试变量
let sandbox;
let mockContext;
let mockEditor;
let mockDocument;

// Mocha 前置钩子：每个测试用例执行前初始化
beforeEach(() => {
  // 创建 Sinon 沙箱（统一管理 Mock/Stub）
  sandbox = sinon.createSandbox();

  // 模拟 VS Code ExtensionContext
  mockContext = {
    subscriptions: [],
    extensionPath: "/test/path",
    storagePath: "/test/storage",
    globalStoragePath: "/test/global",
    logPath: "/test/log",
    workspaceState: {
      get: sandbox.stub(),
      update: sandbox.stub(),
      keys: sandbox.stub(),
      onDidChange: sandbox.stub(),
    },
    globalState: {
      get: sandbox.stub(),
      update: sandbox.stub(),
      keys: sandbox.stub(),
      onDidChange: sandbox.stub(),
      setKeysForSync: sandbox.stub(),
    },
    secrets: {
      get: sandbox.stub(),
      store: sandbox.stub(),
      delete: sandbox.stub(),
      onDidChange: sandbox.stub(),
    },
    environmentVariableCollection: {
      replace: sandbox.stub(),
      append: sandbox.stub(),
      prepend: sandbox.stub(),
      get: sandbox.stub(),
      delete: sandbox.stub(),
      clear: sandbox.stub(),
      getScoped: sandbox.stub().returns({}),
    },
  };

  // 模拟 VS Code TextDocument
  mockDocument = {
    getText: sandbox.stub().returns("<template><div>检查模态</div></template>"),
    languageId: "vue",
    positionAt: sandbox.stub().returns({ line: 0, character: 0 }),
    lineAt: sandbox.stub().returns({ text: "div>检查模态</div>" }),
    uri: { fsPath: "/test/file.vue" },
    getWordRangeAtPosition: sandbox.stub(),
    validatePosition: sandbox.stub(),
    validateRange: sandbox.stub(),
    save: sandbox.stub(),
    lineCount: 1,
    isDirty: false,
    isUntitled: false,
    eol: vscode.EndOfLine.LF,
    version: 1,
  };

  // 模拟 VS Code TextEditor
  mockEditor = {
    document: mockDocument,
    edit: sandbox.stub().resolves(true),
    selection: new vscode.Selection(0, 0, 0, 0),
    selections: [],
    options: {},
    viewColumn: vscode.ViewColumn.One,
    isActive: true,
    isVisible: true,
    revealRange: sandbox.stub(),
    show: sandbox.stub(),
  };

  // 模拟 VS Code 核心 API
  sandbox.stub(vscode.window, "activeTextEditor").value(mockEditor);
  sandbox.stub(vscode.window, "showErrorMessage");
  sandbox.stub(vscode.window, "showInformationMessage");
  sandbox.stub(vscode.window, "showWarningMessage");
  sandbox
    .stub(vscode.workspace, "workspaceFolders")
    .value([{ uri: { fsPath: "/test/workspace" } }]);
  sandbox
    .stub(vscode.commands, "registerCommand")
    .returns({ dispose: sandbox.stub() });
});

// Mocha 后置钩子：每个测试用例执行后清理
afterEach(() => {
  sandbox.restore(); // 重置所有 Sinon Mock/Stub
});

// 测试套件
describe("vue-i18n-llm-translator 插件测试", () => {
  // 1. 测试插件激活逻辑
  it("插件激活应注册翻译命令", () => {
    activate(mockContext);
    assert.strictEqual(mockContext.subscriptions.length, 1);
    assert.ok(
      vscode.commands.registerCommand.calledWith(
        "vue-i18n-llm-translator.translateAll",
      ),
    );
  });

  // 2. 测试非Vue文件执行命令提示错误
  it("非Vue文件执行命令应提示错误信息", async () => {
    // 模拟非Vue文档
    const nonVueDoc = { ...mockDocument, languageId: "javascript" };
    vscode.window.activeTextEditor.value = { document: nonVueDoc };

    // 调用核心处理函数
    const handleTranslateAll = require("../extension").handleTranslateAll;
    await handleTranslateAll();

    // 验证错误提示
    assert.ok(
      vscode.window.showErrorMessage.calledWith("请打开 Vue 文件后执行！"),
    );
  });

  // 3. 测试无工作区时提示错误
  it("未打开工作区应提示错误信息", async () => {
    // 模拟无工作区
    vscode.workspace.workspaceFolders.value = undefined;

    const handleTranslateAll = require("../extension").handleTranslateAll;
    await handleTranslateAll();

    assert.ok(
      vscode.window.showErrorMessage.calledWith("请先打开项目工作区！"),
    );
  });

  // 4. 测试无中文文本时提示信息
  it("无待翻译中文应提示无内容信息", async () => {
    // 模拟无中文的Vue文档
    const emptyDoc = {
      ...mockDocument,
      getText: sandbox.stub().returns("<template><div>test</div></template>"),
    };
    vscode.window.activeTextEditor.value = { document: emptyDoc };

    const handleTranslateAll = require("../extension").handleTranslateAll;
    await handleTranslateAll();

    assert.ok(
      vscode.window.showInformationMessage.calledWith(
        "未检测到可翻译的中文文本！",
      ),
    );
  });

  // 5. 测试中文提取功能
  it("应正确提取Vue文件中的有效中文", () => {
    const extractChineseSmartly = require("../extension").extractChineseSmartly;
    // 模拟带注释和无效文本的Vue内容
    const testDoc = {
      ...mockDocument,
      getText: sandbox.stub().returns(`
        <template>
          <!-- 注释中的检查模态 -->
          <div>检查模态</div>
          <button>影像参数配置</button>
        </template>
        <script>// 注释中的参数
        const a = '配置'; // 过滤项
        </script>
      `),
    };

    const result = extractChineseSmartly(testDoc);
    assert.deepStrictEqual(result, ["检查模态", "影像参数配置"]);
    assert.ok(!result.includes("参数"));
    assert.ok(!result.includes("配置"));
  });

  // 6. 测试重复Key生成逻辑
  it("重复Key应生成递增后缀的唯一Key", () => {
    const getUniqueKey = require("../extension").getUniqueKey;
    // 模拟已有Key的语言包数据
    const langDatas = {
      zh_CN: { check_modality: "检查模态" },
      en_US: { check_modality: "Examination Modality" },
      zh_HK: { check_modality: "檢查模態" },
    };

    // 验证重复Key生成
    const uniqueKey = getUniqueKey("check_modality", langDatas);
    assert.strictEqual(uniqueKey, "check_modality_1");

    // 验证多层重复
    langDatas.zh_CN.check_modality_1 = "测试";
    const uniqueKey2 = getUniqueKey("check_modality", langDatas);
    assert.strictEqual(uniqueKey2, "check_modality_2");
  });

  // 7. 测试LLM翻译生成（正常返回）
  it("LLM返回正确格式应解析出翻译和Key", async () => {
    const llmGenerateTranslation =
      require("../extension").llmGenerateTranslation;
    // Mock axios.post 返回值
    sandbox.stub(axios, "post").resolves({
      data: {
        response: JSON.stringify({
          key: "check_modality",
          en_US: "Examination Modality",
          zh_HK: "檢查模態",
        }),
      },
    });

    const result = await llmGenerateTranslation("检查模态");
    assert.strictEqual(result.key, "check_modality");
    assert.strictEqual(result.en_US, "Examination Modality");
    assert.strictEqual(result.zh_HK, "檢查模態");
  });

  // 8. 测试LLM返回格式错误
  it("LLM返回非JSON格式应抛出错误", async () => {
    const llmGenerateTranslation =
      require("../extension").llmGenerateTranslation;
    // Mock 错误的LLM返回
    sandbox.stub(axios, "post").resolves({
      data: { response: "错误的返回内容" },
    });

    // 验证异常抛出
    await assert.rejects(
      llmGenerateTranslation("检查模态"),
      /LLM 返回格式错误：错误的返回内容/,
    );
  });

  // 9. 测试语言包读取（文件不存在时初始化）
  it("语言包文件不存在应初始化空JSON", async () => {
    const readLangFile = require("../extension").readLangFile;
    // Mock fs.exists 返回false
    sandbox.stub(fs, "exists").resolves(false);
    sandbox.stub(fs, "ensureDir").resolves();
    sandbox.stub(fs, "writeJson").resolves();

    const result = await readLangFile("/test/lang.json");
    assert.deepStrictEqual(result, {});
    assert.ok(fs.writeJson.calledWith("/test/lang.json", {}, { spaces: 4 }));
  });

  // 10. 测试语言包写入（追加模式）
  it("语言包应追加新Key且不覆盖已有Key", async () => {
    const writeToLangFile = require("../extension").writeToLangFile;
    const readLangFile = require("../extension").readLangFile;
    // Mock 已有数据
    sandbox
      .stub(fs, "readFile")
      .resolves(JSON.stringify({ existing_key: "已有内容" }));
    sandbox.stub(fs, "writeFile").resolves();
    sandbox.stub(fs, "exists").resolves(true);
    sandbox.stub(fs, "ensureDir").resolves();

    await writeToLangFile("/test/lang.json", "new_key", "新内容");
    // 验证写入内容包含新旧Key
    assert.ok(
      fs.writeFile.calledWith(
        "/test/lang.json",
        sinon.match.stringContaining('"existing_key": "已有内容"'),
        "utf8",
      ),
    );
    assert.ok(
      fs.writeFile.calledWith(
        "/test/lang.json",
        sinon.match.stringContaining('"new_key": "新内容"'),
        "utf8",
      ),
    );
  });

  // 11. 测试插件注销函数
  it("deactivate函数应无报错执行", () => {
    assert.doesNotThrow(() => deactivate());
  });
});
