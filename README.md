# 成我 · Becoming Me

**一本关于我如何成为我的书。**

我来讲述，AI 帮我整理，解释权始终在我。

成我是一个在本机运行的中文个人历史与百科工具。你可以在同一个长期对话里讲述经历，或导入日记；需要保留的内容先整理成建议，由你确认后再归档。它不追求记录每天的琐事，而是让重要的经历和关于自己的判断有来龙去脉。

## 现在可以用它做什么

- **长期对话与资料库**：接着上次的话题聊，保存日记原文，按需核对出处。
- **事件簿与人生书**：按时间或章节回看经历，记录经过、结果、原话和后来的回访。
- **个人百科**：把关于自己的理解整理成主题条目，支持修改、查看修订和恢复旧版。
- **梦境簿**：单独保存梦的原话和联想，不把梦当成现实事件。

## 在 Windows 本地运行

需要 Node.js 22、npm 和 PowerShell。以下命令从仓库根目录运行：

```powershell
npx --yes --package pnpm@10 pnpm install --frozen-lockfile
npm ci --prefix local-runtime
npx --yes --package pnpm@10 pnpm --filter web build
Copy-Item .\local-runtime\config.example.json .\local-runtime\config.local.json
```

打开 `local-runtime/config.local.json`，填写你实际使用的 OpenAI 兼容 API 地址和模型名。然后运行：

```powershell
.\set-api-key.cmd
.\start-local.cmd
```

密钥通过隐藏输入设置，也可以通过当前进程环境的 `OPENAI_API_KEY` 提供。启动后打开 `http://127.0.0.1:4527/`。

## 数据与隐私

数据库和本机凭据放在 `data/`，不会随代码提交。使用聊天、分析等功能时，该功能所需的上下文会发送到你配置的模型 API；**在本机运行不代表完全离线**。请自行保管资料库备份，不要把真实日记、聊天、人物档案、导出文件或密钥放进 Git。

## 本地验证

```powershell
node --import tsx .\local-runtime\smoke-personal-workspace.mjs
```

该测试使用虚构资料、内存数据库和本机模拟 API。
