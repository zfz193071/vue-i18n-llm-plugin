const axios = require("axios");

const LLM_CONFIG = {
  baseUrl: "http://localhost:11434/api/chat",
  model: "qwen:7b",
  temperature: 0.1,
};

exports.llm = async (prompt) => {
  try {
    const res = await axios.post(LLM_CONFIG.baseUrl, {
      model: LLM_CONFIG.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      temperature: LLM_CONFIG.temperature,
    });

    // 安全获取，防止崩溃
    const content = res.data?.message?.content || "";
    return content.trim();
  } catch (err) {
    console.error("LLM调用失败：", err);
    return "NO"; // 错误时默认返回NO，保证不崩溃
  }
};
