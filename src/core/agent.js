const vscode = require("vscode");
const fs = require("fs").promises;
const path = require("path");

class ReActAgent {
  constructor(mcp) {
    this.mcp = mcp;
    this.llm = mcp.llm;
    this.keyMap = {};
  }

  // ======================
  // 1. THINK（简化提示词！qwen7b能理解）
  // ======================
  async think(code) {
    const prompt = `
你是Vue国际化工具。

代码：
${code.slice(0, 500)}

请判断是否包含中文。
只输出：
YES 或 NO
`;

    const resp = ((await this.llm(prompt)) || "NO").toUpperCase();
    console.log("🤖 THINK 结果：", resp);

    return { needAct: resp === "YES" };
  }

  // ======================
  // 2. ACT（100%依赖LLM提取中文+生成key+翻译）
  // ======================
  async act(code) {
    // -------- 步骤1：让LLM提取中文 --------
    const extractPrompt = `
${this.mcp.getSkill("extract_chinese")}
输入：${code}
输出严格JSON数组，不要其他文字。
`;
    const jsonStr = await this.llm(extractPrompt);
    console.log("提取中文：", jsonStr);

    let list = [];
    try {
      list = JSON.parse(jsonStr);
    } catch (e) {
      console.error("提取失败");
      return;
    }

    // -------- 步骤2：让LLM生成key --------
    for (const text of list) {
      const key = await this.llm(`
${this.mcp.getSkill("generate_key")}
输入：${text}
只输出key。
`);
      this.keyMap[text] = key;

      // -------- 步骤3：让LLM翻译 --------
      const en = await this.llm(`
${this.mcp.getSkill("translate")}
输入：${text} 目标：英文
`);
      const hk = await this.llm(`
${this.mcp.getSkill("translate")}
输入：${text} 目标：香港繁体
`);

      // -------- 步骤4：写入文件 --------
      await this.writeToLocales(key, text, en, hk);
    }
  }

  // ======================
  // 3. OBSERVE（LLM替换代码）
  // ======================
  async observe(code) {
    if (Object.keys(this.keyMap).length === 0) return code;

    const finalCode = await this.llm(`
${this.mcp.getSkill("replace_code")}
原代码：
${code}
映射：${JSON.stringify(this.keyMap)}
输出完整代码，不要解释。
`);

    return finalCode || code;
  }

  // ======================
  // ReAct 主运行
  // ======================
  async run(code) {
    const thought = await this.think(code);
    if (!thought.needAct) {
      console.log("🤖 无需处理");
      return code;
    }

    await this.act(code);
    return await this.observe(code);
  }

  // ======================
  // 写入多语言JSON（依赖LLM结果）
  // ======================
  async writeToLocales(key, zh, en, hk) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const base = path.join(root, "src/locales/lang");
    await fs.mkdir(base, { recursive: true });

    const files = {
      zh_CN: path.join(base, "zh_CN.json"),
      en_US: path.join(base, "en_US.json"),
      zh_HK: path.join(base, "zh_HK.json"),
    };

    for (const lang in files) {
      let data = {};
      try {
        data = JSON.parse(await fs.readFile(files[lang], "utf8"));
      } catch {}

      const value = { zh_CN: zh, en_US: en, zh_HK: hk }[lang];
      if (!data[key]) {
        data[key] = value;
        await fs.writeFile(files[lang], JSON.stringify(data, null, 2));
      }
    }
  }
}

module.exports = ReActAgent;
