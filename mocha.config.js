// mocha.config.js
const path = require("path");
const modulePaths = [path.join(__dirname, "__mocks__")];

// 将 Mock 路径添加到 Node 模块搜索路径
modulePaths.forEach((p) => {
  if (!module.paths.includes(p)) {
    module.paths.push(p);
  }
});

// Mocha 配置
module.exports = {
  ui: "bdd",
  timeout: 5000,
  color: true,
  spec: "src/test/extension.test.js",
};
