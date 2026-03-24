const fs = require("fs").promises;
const path = require("path");

class MCP {
  constructor(llm) {
    this.llm = llm;
    this.skills = new Map();
  }

  async loadSkills() {
    const skillDir = path.join(__dirname, "../../skills");
    const files = await fs.readdir(skillDir);
    for (const file of files) {
      const name = file.replace(".md", "");
      const content = await fs.readFile(path.join(skillDir, file), "utf8");
      this.skills.set(name, content);
    }
  }

  getSkill(name) {
    return this.skills.get(name) || "";
  }
}

module.exports = MCP;
