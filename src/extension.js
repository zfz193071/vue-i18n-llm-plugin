const vscode = require("vscode");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const _ = require("lodash");

// 本地LLM配置（Qwen-7B）
const LLM_CONFIG = {
  baseUrl: "http://localhost:11434/api/generate",
  model: "qwen:7b",
  temperature: 0.1, // 低温度保证翻译精准
  maxTokens: 500,
};

/**
 * 插件激活入口
 */
function activate(context) {
  // 注册右键命令
  const translateCommand = vscode.commands.registerCommand(
    "vue-i18n-llm-plugin.translateAll",
    async () => await handleTranslateAll(),
  );
  context.subscriptions.push(translateCommand);
}

/**
 * 核心：批量翻译Vue文件所有中文
 */
async function handleTranslateAll() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "vue") {
    vscode.window.showErrorMessage("请打开Vue文件后执行！");
    return;
  }

  const document = editor.document;
  const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  // 语言包路径配置
  const langPaths = {
    zh_CN: path.join(workspaceFolder, "src", "locales", "lang", "zh_CN.json"),
    en_US: path.join(workspaceFolder, "src", "locales", "lang", "en_US.json"),
    zh_HK: path.join(workspaceFolder, "src", "locales", "lang", "zh_HK.json"),
  };

  try {
    // 步骤1：智能提取Vue中的中文（排除注释/代码逻辑）
    const chineseTexts = extractChineseSmartly(document);
    if (chineseTexts.length === 0) {
      vscode.window.showInformationMessage("未检测到可翻译的中文文本！");
      return;
    }
    vscode.window.showInformationMessage(
      `检测到${chineseTexts.length}个待翻译中文，开始AI处理...`,
    );

    // 步骤2：预读取已有语言包（避免重复生成key）
    const existingLangData = {
      zh_CN: await readLangFile(langPaths.zh_CN),
      en_US: await readLangFile(langPaths.en_US),
      zh_HK: await readLangFile(langPaths.zh_HK),
    };

    // 步骤3：批量处理每个中文文本
    let successCount = 0;
    for (const text of chineseTexts) {
      // 跳过已存在的中文（语义去重）
      if (isTextAlreadyTranslated(text, existingLangData.zh_CN)) {
        continue;
      }

      try {
        // 步骤3.1：大模型生成翻译+规范key
        const { key, en_US, zh_HK } = await llmGenerateTranslation(text);

        // 步骤3.2：写入语言包（追加模式，不覆盖）
        await writeToLangFile(langPaths.zh_CN, key, text);
        await writeToLangFile(langPaths.en_US, key, en_US);
        await writeToLangFile(langPaths.zh_HK, key, zh_HK);

        // 步骤3.3：替换Vue文件中的中文为$t语法
        await replaceTextInVue(editor, text, key);

        successCount++;
      } catch (err) {
        vscode.window.showWarningMessage(`处理"${text}"失败：${err.message}`);
        continue;
      }
    }

    vscode.window.showInformationMessage(
      `AI翻译完成！新增${successCount}个词条（已跳过重复项）`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`批量翻译失败：${error.message}`);
    console.error("LLM翻译插件错误：", error);
  }
}

/**
 * 智能提取Vue中的中文（基于正则+过滤规则，适配医学影像场景）
 */
function extractChineseSmartly(document) {
  const fullText = document.getText();
  // 1. 先移除注释（单行/多行），避免提取注释中的中文
  const textWithoutComment = fullText
    .replace(/<!--[\s\S]*?-->/g, "") // 移除HTML注释
    .replace(/\/\/.*/g, "") // 移除JS单行注释
    .replace(/\/\*[\s\S]*?\*\//g, ""); // 移除JS多行注释

  // 2. 匹配2个及以上中文字符（排除单字误匹配）
  const chineseRegex = /[\u4e00-\u9fa5]{2,}/g;
  const matches = textWithoutComment.match(chineseRegex) || [];

  // 3. 去重+过滤无效中文（适配医学影像场景）
  const ignoreList = [
    "props",
    "model",
    "label",
    "key",
    "value",
    "ref",
    "style",
    "class",
    "参数",
    "配置",
    "选项", // 可自定义过滤项
  ];
  return [...new Set(matches)].filter((text) => {
    const trimmed = text.trim();
    return trimmed.length > 1 && !ignoreList.includes(trimmed);
  });
}

/**
 * 检查文本是否已翻译（语义去重，而非纯字符匹配）
 */
function isTextAlreadyTranslated(text, langData) {
  // 1. 纯字符匹配（优先）
  if (Object.values(langData).includes(text)) {
    return true;
  }
  // 2. 简单语义匹配（比如“检查模态”和“影像检查模态”视为同一语义）
  const textKeywords = text.replace(/[\s|，。！？]/g, "");
  return Object.values(langData).some((value) => {
    const valueKeywords = value.replace(/[\s|，。！？]/g, "");
    return (
      valueKeywords.includes(textKeywords) ||
      textKeywords.includes(valueKeywords)
    );
  });
}

/**
 * 调用本地Qwen-7B生成翻译+规范i18n key
 * @param {string} text 待翻译的中文文本
 * @returns {object} { key, en_US, zh_HK }
 */
async function llmGenerateTranslation(text) {
  // Prompt设计（关键：指定医学影像行业、规范key命名）
  const prompt = `
  你是专业的医学影像行业国际化工程师，请完成以下任务：
  1. 为中文文本生成规范的i18n key：
     - 格式：小写+下划线，前缀为medical_imaging_
     - 示例：检查模态 → medical_imaging_check_modality
  2. 将中文翻译为：
     - en_US：美式英文（医学影像专业术语，精准）
     - zh_HK：香港繁体中文（符合香港用词习惯）
  3. 仅返回JSON格式，无任何多余内容，JSON结构：
     {
       "key": "生成的key",
       "en_US": "英文翻译",
       "zh_HK": "香港繁体翻译"
     }
  需要处理的中文文本：${text}
  `;

  // 调用本地LLM
  const response = await axios.post(LLM_CONFIG.baseUrl, {
    model: LLM_CONFIG.model,
    prompt: prompt.trim(),
    temperature: LLM_CONFIG.temperature,
    max_tokens: LLM_CONFIG.maxTokens,
    stream: false, // 关闭流式输出，直接获取完整结果
  });

  // 解析LLM输出（容错处理）
  let result;
  try {
    result = JSON.parse(response.data.response);
  } catch (err) {
    throw new Error(
      `LLM返回格式错误：${response.data.response.substring(0, 100)}`,
    );
  }

  // 验证结果完整性
  if (!result.key || !result.en_US || !result.zh_HK) {
    throw new Error(`LLM未生成完整结果：${JSON.stringify(result)}`);
  }

  return {
    key: result.key.trim(),
    en_US: result.en_US.trim(),
    zh_HK: result.zh_HK.trim(),
  };
}

/**
 * 读取语言包文件（不存在则初始化空对象）
 */
async function readLangFile(filePath) {
  if (!(await fs.exists(filePath))) {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, {}, { spaces: 2 });
    return {};
  }
  return await fs.readJson(filePath);
}

/**
 * 写入语言包（追加模式，不覆盖已有key）
 */
async function writeToLangFile(filePath, key, value) {
  const langData = await readLangFile(filePath);
  // 仅当key不存在时追加
  if (!langData[key]) {
    langData[key] = value;
    // 格式化写入（保持JSON整洁）
    await fs.writeJson(filePath, langData, { spaces: 2 });
  }
}

/**
 * 替换Vue文件中的中文为$t语法（适配属性绑定/普通文本）
 */
async function replaceTextInVue(editor, text, key) {
  await editor.edit((editBuilder) => {
    const fullText = editor.document.getText();
    const regex = new RegExp(_.escapeRegExp(text), "g");
    let match;

    while ((match = regex.exec(fullText)) !== null) {
      const startPos = editor.document.positionAt(match.index);
      const endPos = editor.document.positionAt(match.index + text.length);
      const range = new vscode.Range(startPos, endPos);

      // 区分属性绑定（如label="检查模态" → :label="$t('key')"）和普通文本
      const lineText = editor.document.lineAt(startPos.line).text;
      let replaceStr = `$t('${key}')`;

      // 如果是属性赋值（无:开头），添加:前缀
      if (
        lineText.includes(`="${text}"`) &&
        !lineText.includes(`:="${text}"`)
      ) {
        const attrRange = new vscode.Range(
          startPos.with(undefined, startPos.character - 1),
          startPos,
        );
        // 先添加:前缀
        editBuilder.insert(attrRange.start, ":");
        // 替换文本
        editBuilder.replace(range, replaceStr);
      } else {
        // 普通文本（如{{ 检查模态 }}）直接替换
        editBuilder.replace(range, replaceStr);
      }
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
