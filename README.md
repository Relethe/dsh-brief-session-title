# dsh-brief-session-title

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) session-title plugin that condenses a full sentence into a single word for easier recall.

## Why this plugin

DSH generates session titles with the official `session-title-first-prompt-llm` plugin, which often outputs a complete sentence — a verbatim echo like "Explain what JavaScript closures are" ends up in the sidebar, long and hard to scan.

The root cause is the official prompt: its only length constraint is **"Aim for about 5 words"** — "aim for" is a soft target that models routinely overshoot, and it asks for "concise" without showing what concise means. **The goal is not specific enough, and that is what makes titles wordy.**

This plugin keeps all official logic untouched and changes exactly one thing: **the system prompt** — explicit rules plus correct/incorrect examples that turn "concise" into an executable standard.

## Examples

| Session content (original) | This plugin's title |
|---|---|
| 解释一下JavaScript闭包到底是什么 | **JS闭包浅说** |
| 用英语表达中国近代半文言文文法 | **半文言文法表达** |
| 中式微恐2.5D沙盒生存游戏系统PRD | **游戏PRD** |
| Fixing Memory Leak in Node | **Node memory leak** |
| Database Schema Design Review | **Schema review** |

## Core idea: prompt optimization

The new prompt gives the model four hard rules:

1. **PLAIN ENGLISH for English output** — plain and direct;
2. **literary-vernacular hybrid for Chinese output** — a compact classical-modern blend (e.g. "浅说", "文法表达");
3. **Avoid verbs in the output** — verbs are the skeleton of a sentence; remove them and the sentence collapses into a phrase;
4. **Shrink to under 5 words, like a professional poet** — shorter is better.

Six correct/incorrect example pairs anchor the target style, so the model imitates the pattern instead of guessing what "concise" means.

## Features

- **No copied strategy code**: it registers a `first-prompt` provider and calls the official `generateSessionTitleWithLlm()` from `@deepseek-ai/dsh-session-title-llm`, so framing, byte/token caps, the timeout code, tool-call rejection, title normalization, and the `session/title-llm-request` log event all stay official; the only difference is the system prompt — both in the request sent to the model and in the logged event;
- **Exactly one provider**: the bundle patch disables the official plugin, and the title service rejects a second registration, so two generators can never compete;
- **Fail-safe**: on model error, timeout, or empty output, it falls back to the official deterministic fallback title;
- **Configurable**: input byte cap, output token cap, and timeout are all tunable.

## Compatibility

Requires DSH 0.2.x (`@deepseek-ai/dsh-session-title*` >= 0.2.0-0). Because no strategy code is copied, official upgrades are picked up automatically; if the shared function signature changes, the plugin fails loudly instead of writing a malformed log event.

## Installation

This plugin is a dsh bundle — install it directly from GitHub, no manual config editing:

```bash
dsh plugin --profile web add github:Relethe/dsh-brief-session-title
```

If the package is published to npm, the same command works with the package name:

```bash
dsh plugin --profile web add dsh-brief-session-title
```

For a local checkout (relative paths resolve against your invoking directory):

```bash
dsh plugin --profile web add ./dsh-brief-session-title
```

`dsh plugin` forwards its arguments to pnpm and then reconciles: because this package declares `dsh.bundle`, it joins the profile's bundle layer automatically, and the bundle's own `cordis.patch.yml` applies (disable the official title plugin + mount this one).

**Restart DSH — new session titles take effect from then on.**

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxInputBytes` | 4096 | UTF-8 byte cap for the framed JSON input; oversized input fails instead of truncating |
| `maxOutputTokens` | 64 | Output-token cap for the title request |
| `timeoutMs` | 60000 | Per-request timeout in milliseconds |
| `provider` / `model` | omitted | Supply both to use a dedicated route; omit to reuse the session's main-request route |

`targetWords` / `targetCjkCharacters` are intentionally not exposed: the custom prompt fixes its own length rules, so those official knobs have nothing to configure here.

## Notes

- **New titles only**: existing sessions keep their stored titles;
- **Manual renames pin**: a user-renamed title is never overwritten by automatic generation (official DSH behavior);
- **To revert**: `dsh plugin --profile web remove dsh-brief-session-title` — the official title plugin resumes automatically.

## License

MIT
