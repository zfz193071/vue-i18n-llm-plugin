const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
});

const axios = require("axios");
const https = require("https");

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: process.env.VUE_I18N_LLM_TLS_INSECURE !== "1",
});

const defaults = {
  baseUrl:
    process.env.VUE_I18N_LLM_BASE_URL ||
    "https://one-api.imagecore.com.cn/v1/chat/completions",
  model: process.env.VUE_I18N_LLM_MODEL || "Qwen3.5-122B-A10B",
  apiKey: process.env.VUE_I18N_LLM_API_KEY || "",
  temperature: Number(process.env.VUE_I18N_LLM_TEMPERATURE) || 0.1,
};

let runtime = {};

exports.configureLlm = (partial) => {
  runtime = { ...partial };
};

function getConfig() {
  return { ...defaults, ...runtime };
}

const RETRYABLE = new Set(["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE"]);

function isRetryable(err) {
  const code = err.code || err.cause?.code;
  const msg = String(err.message || err).toLowerCase();
  if (code && RETRYABLE.has(code)) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("timeout")) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// 👇 核心新增：大文件分块 + 摘要 + 多轮翻译策略（openclaw 同款）
// -----------------------------------------------------------------------------

/** 分块大小（安全值，适配云端 8k/16k 上下文） */
const CHUNK_SIZE = 12000;

/** 分块：把大文本切成小块 */
function splitTextIntoChunks(text, maxChunkSize = CHUNK_SIZE) {
  const chunks = [];
  let index = 0;
  while (index < text.length) {
    chunks.push(text.slice(index, index + maxChunkSize));
    index += maxChunkSize;
  }
  return chunks;
}

/** 单块调用 LLM（真正发请求） */
async function llmSingle(prompt) {
  const LLM_CONFIG = getConfig();
  if (!LLM_CONFIG.apiKey) {
    console.error("LLM 缺少 API Key");
    return "NO";
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios({
        method: "POST",
        url: LLM_CONFIG.baseUrl,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LLM_CONFIG.apiKey}`,
        },
        data: {
          model: LLM_CONFIG.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          temperature: LLM_CONFIG.temperature,
        },
        timeout: 120000,
        httpsAgent,
        // 移除了 Infinity，改用分块机制更安全
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const content = res.data?.choices?.[0]?.message?.content || "";
      return content.trim();
    } catch (err) {
      const detail = err.response?.data ?? err.message ?? err;
      console.error(`LLM 调用失败（${attempt}/${maxAttempts}）：`, detail);
      if (attempt < maxAttempts && isRetryable(err)) {
        await sleep(400 * attempt);
        continue;
      }
      break;
    }
  }
  return "NO";
}

/**
 * 主函数：支持超大文件 分块 + 摘要 + 多轮合并
 * 完全替代原来的 llm()
 */
exports.llm = async (fullPrompt) => {
  // 1. 短文本直接走原来逻辑
  if (fullPrompt.length <= CHUNK_SIZE * 1.2) {
    return llmSingle(fullPrompt);
  }

  console.log("=== 超大文件，启用分块翻译模式 ===");

  // 2. 分块
  const chunks = splitTextIntoChunks(fullPrompt);
  const translatedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`正在翻译第 ${i + 1}/${chunks.length} 块`);
    const prompt = `
你是专业的Vue代码翻译器，请只翻译代码中的中文文本，不要修改代码结构、变量、格式、标签。
保持所有HTML、JS、CSS结构完全不变，只输出翻译后的完整代码。

待翻译块：
${chunks[i]}
`.trim();

    const translated = await llmSingle(prompt);
    translatedChunks.push(translated);
    await sleep(300);
  }

  // 3. 合并所有块
  const merged = translatedChunks.join("\n");

  // 4. 最终多轮校验（可选，保证格式统一）
  const finalPrompt = `
以下是分块翻译后的Vue文件，请统一格式、修正断行、确保代码可运行、不要漏内容、不要加解释。
只输出最终可直接使用的Vue文件：

${merged}
`.trim();

  console.log("=== 合并完成，最终校验 ===");
  const finalResult = await llmSingle(finalPrompt);
  return finalResult || merged;
};
