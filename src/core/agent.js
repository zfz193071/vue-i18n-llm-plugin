const vscode = require("vscode");
const fs = require("fs").promises;
const path = require("path");

class ReActAgent {
  constructor(mcp) {
    this.mcp = mcp;
    this.llm = mcp.llm;
    this.keyMap = {};
  }

  sanitizeLLMText(text) {
    if (!text) return "";
    return String(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  parseJsonArray(text) {
    const cleaned = this.sanitizeLLMText(text);
    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) return [];
      try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }

  extractChineseFallback(code) {
    const all = code.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    return [...new Set(all)];
  }

  escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 与技能一致：至少连续 2 个汉字才算待国际化文案 */
  hasChineseToProcess(code) {
    return /[\u4e00-\u9fa5]{2,}/.test(code);
  }

  /** 本地判断，不调用 LLM。避免 Ollama 失败时 llm 返回 "NO" 被误判为「无中文」而整段跳过。 */
  thinkLocal(code) {
    const need = this.hasChineseToProcess(code);
    console.log("🤖 THINK(本地)：", need ? "YES" : "NO");
    return { needAct: need };
  }

  fallbackKey(text, index) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    const suffix = Math.abs(h).toString(36);
    return `i18n_${suffix}_${index}`;
  }

  // ======================
  // 1. THINK（仅用本地规则；LLM 失败不得阻断流程）
  // ======================
  async think(code) {
    return this.thinkLocal(code);
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

    let list = this.parseJsonArray(jsonStr)
      .map((item) => String(item || "").trim())
      .filter((item) => /[\u4e00-\u9fa5]{2,}/.test(item));
    if (list.length === 0) {
      list = this.extractChineseFallback(code);
      console.warn("LLM提取为空，已使用本地规则兜底提取：", list);
    }

    // -------- 步骤2：让LLM生成key --------
    for (let i = 0; i < list.length; i++) {
      const text = list[i];
      const keyResp = await this.llm(`
${this.mcp.getSkill("generate_key")}
输入：${text}
只输出key。
`);
      let key = this.sanitizeLLMText(keyResp).replace(/['"`]/g, "").trim();
      if (!key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
        key = this.fallbackKey(text, i);
        console.warn("LLM 未返回合法 key，使用兜底：", text, "->", key);
      }
      this.keyMap[text] = key;

      // -------- 步骤3：让LLM翻译 --------
      let en = this.sanitizeLLMText(await this.llm(`
${this.mcp.getSkill("translate")}
输入：${text} 目标：英文
`));
      let hk = this.sanitizeLLMText(await this.llm(`
${this.mcp.getSkill("translate")}
输入：${text} 目标：香港繁体
`));
      if (!en) en = text;
      if (!hk) hk = text;

      // -------- 步骤4：写入文件 --------
      await this.writeToLocales(key, text, en, hk);
    }
  }

  // ======================
  // 3. OBSERVE（LLM替换代码）
  // ======================
  async observe(code) {
    if (Object.keys(this.keyMap).length === 0) return code;
    let finalCode = code;
    const entries = Object.entries(this.keyMap).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [zh, key] of entries) {
      const matcher = new RegExp(this.escapeRegExp(zh), "g");
      finalCode = finalCode.replace(matcher, `t('${key}')`);
    }
    return finalCode;
  }

  // ======================
  // ReAct 主运行
  // ======================
  async run(code) {
    const thought = await this.think(code);
    if (!thought.needAct) {
      console.log("🤖 无需处理");
      return { code, replacedCount: 0 };
    }

    await this.act(code);
    const newCode = await this.observe(code);
    return {
      code: newCode,
      replacedCount: Object.keys(this.keyMap).length,
    };
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
