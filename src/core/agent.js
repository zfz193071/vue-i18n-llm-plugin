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

  extractValidKey(text) {
    const cleaned = this.sanitizeLLMText(text).replace(/['"`]/g, " ");
    const m = cleaned.match(/[a-zA-Z][a-zA-Z0-9_]*/);
    return m ? m[0] : "";
  }

  normalizeTranslation(text, fallback) {
    const cleaned = this.sanitizeLLMText(text);
    if (!cleaned) return fallback;
    // 兼容：Output: "xxx" translated to "yyy" ...
    const translatedTo = cleaned.match(/translated to\s+["'`](.+?)["'`]/i);
    if (translatedTo?.[1]) return translatedTo[1].trim();
    const firstQuoted = cleaned.match(/["'`](.+?)["'`]/);
    if (firstQuoted?.[1] && firstQuoted[1].trim().length > 0) {
      return firstQuoted[1].trim();
    }
    return cleaned;
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

  extractVueSections(code) {
    const templateRegex = /<template\b[^>]*>[\s\S]*?<\/template>/i;
    const scriptRegex = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
    const template = code.match(templateRegex)?.[0] || "";
    const scripts = code.match(scriptRegex) || [];
    return { template, scripts, templateRegex, scriptRegex };
  }

  extractTaggedResult(text) {
    const cleaned = this.sanitizeLLMText(text);
    const tagged = cleaned.match(/<RESULT>([\s\S]*?)<\/RESULT>/i);
    return tagged?.[1]?.trim() || cleaned;
  }

  async llmTransformTemplate(templateCode) {
    if (!templateCode) return templateCode;
    const prompt = `
你是资深 Vue i18n 重构助手。请只处理 <template> 代码。

要求：
1) 纯文本中文替换为 {{ t('key') }}
2) 属性里的中文替换为 :attr="t('key')"（原本已是动态绑定则直接改表达式）
3) 不要改动已有 t(...) 语义
4) 保持原有标签结构、空格和换行尽量不变

映射(JSON)：
${JSON.stringify(this.keyMap, null, 2)}

模板代码：
${templateCode}

只输出：
<RESULT>...完整template代码...</RESULT>
`;
    const resp = await this.llm(prompt);
    return this.extractTaggedResult(resp) || templateCode;
  }

  async llmTransformScript(scriptCode) {
    if (!scriptCode) return scriptCode;
    const prompt = `
你是资深 Vue i18n 重构助手。请只处理 <script> 代码。

要求：
1) 把中文字符串替换为 t('key')（script 中不能使用 {{ }}）
2) 若需要，补齐 vue-i18n 的导入与 t 初始化（setup 风格优先 useI18n）
3) 不要改动无关逻辑、变量名、类型定义
4) 保持代码可运行

映射(JSON)：
${JSON.stringify(this.keyMap, null, 2)}

脚本代码：
${scriptCode}

只输出：
<RESULT>...完整script代码...</RESULT>
`;
    const resp = await this.llm(prompt);
    return this.extractTaggedResult(resp) || scriptCode;
  }

  extractChineseFallback(code) {
    const all = code.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    return [...new Set(all)];
  }

  escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  replaceTemplateText(templateCode, zh, key) {
    const safe = this.escapeRegExp(zh);
    const textNode = new RegExp(`>(\\s*)${safe}(\\s*)<`, "g");
    return templateCode.replace(textNode, `>$1{{ t('${key}') }}$2<`);
  }

  replaceTemplateAttr(templateCode, zh, key) {
    const safe = this.escapeRegExp(zh);
    // 静态属性：placeholder="中文" -> :placeholder="t('key')"
    const staticAttr = new RegExp(`(\\s)([a-zA-Z_][\\w-]*)(\\s*=\\s*)(["'])${safe}\\4`, "g");
    return templateCode.replace(staticAttr, `$1:$2$3"t('${key}')"`);
  }

  replaceScriptString(scriptCode, zh, key) {
    const safe = this.escapeRegExp(zh);
    const singleQuoted = new RegExp(`'${safe}'`, "g");
    const doubleQuoted = new RegExp(`"${safe}"`, "g");
    return scriptCode
      .replace(singleQuoted, `t('${key}')`)
      .replace(doubleQuoted, `t('${key}')`);
  }

  ensureUseI18nInScriptSetup(scriptCode, changedInScript) {
    if (!changedInScript) return scriptCode;
    if (!/<script\b[^>]*setup[^>]*>/i.test(scriptCode)) return scriptCode;
    let out = scriptCode;
    if (!/from\s+["']vue-i18n["']/.test(out)) {
      out = out.replace(
        /(<script\b[^>]*setup[^>]*>\s*)/i,
        `$1import { useI18n } from "vue-i18n";\n`,
      );
    }
    if (!/\buseI18n\s*\(/.test(out)) {
      out = out.replace(
        /(<script\b[^>]*setup[^>]*>[\s\S]*?)(\n)/i,
        `$1\nconst { t } = useI18n();$2`,
      );
    }
    return out;
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
  // 2. ACT（远程大模型：提取 + 批量生成 key/翻译）
  // ======================
  async act(code) {
    const { template, scripts } = this.extractVueSections(code);
    const promptInput = [template, ...scripts].filter(Boolean).join("\n\n");

    // -------- 步骤1：让LLM提取中文 --------
    const extractPrompt = `
${this.mcp.getSkill("extract_chinese")}
输入：${promptInput}
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

    // -------- 步骤2：批量生成 key + 翻译（减少调用次数）--------
    const batchPrompt = `
你是 i18n 词条生成器。根据输入中文数组，输出严格 JSON 数组。
每个元素结构：
{"text":"原中文","key":"camel_or_snake_key","en_US":"英文","zh_HK":"香港繁体"}
要求：
1) key 仅允许 [a-zA-Z][a-zA-Z0-9_]*
2) 不要输出任何解释、Markdown、注释
3) 输出顺序与输入一致

输入：
${JSON.stringify(list)}
`;
    const batchResp = await this.llm(batchPrompt);
    const batch = this.parseJsonArray(batchResp);
    const byText = new Map();
    for (const x of batch) {
      const text = String(x?.text || "").trim();
      if (!text) continue;
      byText.set(text, {
        key: this.extractValidKey(x?.key || ""),
        en_US: this.normalizeTranslation(x?.en_US || "", ""),
        zh_HK: this.normalizeTranslation(x?.zh_HK || "", ""),
      });
    }

    for (let i = 0; i < list.length; i++) {
      const text = list[i];
      const meta = byText.get(text) || {};
      let key = meta.key;
      if (!key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
        key = this.fallbackKey(text, i);
      }
      const en = meta.en_US || text;
      const hk = meta.zh_HK || text;
      this.keyMap[text] = key;
      await this.writeToLocales(key, text, en, hk);
    }
  }

  // ======================
  // 3. OBSERVE（由大模型决定 template/script 替换）
  // ======================
  async observe(code) {
    if (Object.keys(this.keyMap).length === 0) return code;
    let finalCode = code;
    const { template, scripts, templateRegex, scriptRegex } = this.extractVueSections(code);
    if (template) {
      const transformedTemplate = await this.llmTransformTemplate(template);
      finalCode = finalCode.replace(templateRegex, transformedTemplate);
    }
    if (scripts.length > 0) {
      const newScripts = [];
      for (const scriptCode of scripts) {
        newScripts.push(await this.llmTransformScript(scriptCode));
      }
      let idx = 0;
      finalCode = finalCode.replace(scriptRegex, () => newScripts[idx++] || "");
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
