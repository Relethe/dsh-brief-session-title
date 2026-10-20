# dsh-brief-session-title

[English](README.md) | 中文

DeepSeek Harness（DSH）会话标题精简插件：把「一句完整的话」压成「一个词」，便于回忆。

## 为什么做这个插件

DSH 的会话标题由官方 `session-title-first-prompt-llm` 插件生成。它经常输出一句完整的话——"解释一下 JavaScript 闭包到底是什么"这种原样照搬的句子会直接出现在侧边栏里，冗长、不便于扫读和回忆。

问题根源在官方提示词：它的长度约束只有一句 **"Aim for about 5 words"**——"目标大约是"是软约束，模型容易超；而且它只要求"简洁"，没有告诉模型"简洁成什么样"。**目标不够明确，是标题冗长的主要原因。**

本插件不动官方任何逻辑，只做一件事：**重写系统提示词**，用明确规则 + 正反例句，把"简洁"变成可执行的标准。

## 效果样例

| 会话内容（原句） | 本插件输出 |
|---|---|
| 解释一下JavaScript闭包到底是什么 | **JS闭包浅说** |
| 用英语表达中国近代半文言文文法 | **半文言文法表达** |
| 中式微恐2.5D沙盒生存游戏系统PRD | **游戏PRD** |
| Fixing Memory Leak in Node | **Node memory leak** |
| Database Schema Design Review | **Schema review** |

## 核心思路：提示词优化

新提示词给了模型四条硬规则：

1. **英语按 PLAIN ENGLISH 原则**——平实、直接；
2. **中文按文白相间（literary-vernacular hybrid）原则**——文言白话结合，凝练（如"浅说""文法表达"）；
3. **输出中避免动词**——动词是"句子"的骨架，去掉动词，句子自然塌缩成词组；
4. **尽力压到 5 个词以内，像一个专业诗人**——宁短勿长。

再加上**六组正反例句**（Incorrect / Correct 对照），让模型直接"抄"出目标风格，而不是猜测"简洁"是什么意思。

## 特性

- **不复制策略代码**：注册一个 `first-prompt` 提供方，直接调用官方 `@deepseek-ai/dsh-session-title-llm` 的 `executeSessionTitleLlm()`；输入字节上限、输出 token 上限、超时原因码、路由解析、`session/title-llm-request` 日志事件全部沿用官方实现，差异只有系统提示词和首行标题提取（与官方 first-prompt 插件同样的处理）；
- **唯一提供方**：bundle patch 关闭官方插件，标题服务本身也拒绝第二个注册，两个生成器不会并存；
- **失败安全**：模型报错、超时、输出为空时，自动回落到官方确定性 fallback 标题，会话不会没标题；
- **纯配置可调**：输入字节上限、输出 token 上限、超时时间均可配。

## 兼容性

要求 DSH 0.2.1-rc.x（`@deepseek-ai/dsh-session-title*` >= 0.2.1-0）。DSH 0.2.1 把共享的 `generateSessionTitleWithLlm()` 换成了 `executeSessionTitleLlm()`，提示词组装与输出解析也回到 provider 侧；本版本针对该接口。若之后的 DSH 再次改动共享签名，插件会直接报错，而不是写出不合规的会话日志事件。

## 安装

本插件是一个 dsh bundle，直接通过 GitHub 安装即可，无需手动改任何配置：

```bash
dsh plugin --profile <name> add github:Relethe/dsh-brief-session-title
```

`<name>` 是你要管理的 profile（`web`、`headless`、`desktop` 等）。桌面版也可以在侧边栏**插件**页完成同样的操作；两条路径都写 profile 的 `package.json`，并应用 bundle 自带的 patch 层。

发布到 npm 后，也可以用包名安装：

```bash
dsh plugin --profile <name> add dsh-brief-session-title
```

本地目录安装（相对路径以你执行命令的目录为基准，绝对路径直接传）：

```bash
dsh plugin --profile <name> add ./dsh-brief-session-title
```

安装时 `dsh plugin` 会把参数转发给 pnpm，装完后自动对账：检测到本包声明了 `dsh.bundle`，就会把它加入 profile 的 bundle 层；bundle 自带的 `cordis.patch.yml` 随之自动应用（禁用官方标题插件 + 挂载本插件）。

**重启 DSH 后，新会话的标题即生效。**

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `maxInputBytes` | 4096 | 输入 JSON 帧的字节上限，超限直接失败（不截断历史） |
| `maxOutputTokens` | 64 | 标题请求的输出 token 上限 |
| `timeoutMs` | 60000 | 单次标题请求超时（毫秒） |
| `provider` / `model` | 省略 | 同时给出则用独立路由生成标题；省略则复用当前会话主请求的路由 |

`targetWords` / `targetCjkCharacters` 故意不开放：自定义提示词写死了自己的长度规则，官方这两个旋钮在这里没有可配的东西。

## 注意事项

- **只影响之后的标题**：已存在会话的标题已落盘，不会自动重算；
- **手动改名会钉住**：用户在 UI 里手动改过标题后，自动生成不再覆盖（DSH 官方行为）；
- **还原方式**：`dsh plugin --profile <name> remove dsh-brief-session-title`，官方标题插件自动恢复。

## 许可

MIT
