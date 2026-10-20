/**
 * dsh-brief-session-title —— 极简会话标题插件。
 *
 * 与官方 @deepseek-ai/dsh-session-title-first-prompt-llm 的差异只有系统提示词。
 * 其余全部复用 @deepseek-ai/dsh-session-title-llm 的官方实现：
 *  - 消息选择（第一条例人类消息）、JSON 帧格式与字节上限；
 *  - deadline() + SESSION_TITLE_TIMEOUT 超时、输出 token 上限；
 *  - tool-call 拒绝、空标题拒绝、normalizeSessionTitle 归一化；
 *  - 模型分发前写入 session/title-llm-request 的字段与 message source。
 *
 * 适配 DSH 0.2.1-rc.x：共享库不再提供 generateSessionTitleWithLlm()，
 * 改为 executeSessionTitleLlm(ctx, config, request, providerId, prepared)。
 * prepared 由 provider 自己提供 system / input / messageSeqs / 推理档位选择，
 * 输出解析（tool-call、max-tokens、首行提取）也回到 provider 侧。
 *
 * 因此官方升级时，本插件只需跟随共享模块的函数签名；提示词与输出解析
 * 由本插件自己承担。
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
} from '@deepseek-ai/dsh-session-title-llm'
import { SessionTitleProviderId, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-brief-session-title'

/**
 * 声明的依赖服务就绪后才执行 apply；缺了它，一旦加载顺序变化，apply 会在
 * 服务注册前运行并抛错，整棵插件树随之加载失败。
 */
export const inject = ['sessionTitle', 'llm', 'sessions']

/** 默认值单点定义：Config 默认值与直接调用 apply 时的补全共用。 */
const DEFAULTS = Object.freeze({
  maxInputBytes: 4096,
  maxOutputTokens: 64,
  timeoutMs: 60000,
})

/**
 * 自定义系统提示词：只改文字，不改任何调用策略。
 *
 * 写作要点（来自实测）：
 *  1. 长度约束必须写成硬规则（"less than 5 words"）——官方的 "Aim for about 5
 *     words" 是软目标，模型普遍超额，侧边栏里就会出现整句；
 *  2. 正反例句都不加包裹引号——带引号时模型会连引号一起模仿；
 *  3. 中文要求"文白夹杂"、英文要求"plain English"，并去掉动词，句子才会塌缩成词组。
 */
const SYSTEM_PROMPT = [
  'Generate a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line in raw plain text: no quotes, no prefix, no explanation, no Markdown, no XML, no terminal control codes. No code is allowed.',
  "Print with the principle of PLAIN ENGLISH if it's English.",
  "Print with the principle of literary-vernacular hybrid if it's Chinese.",
  'Follow the original language of the messages.',
  'Avoid using the verb of sentence in output.',
  'Shorten the length of output to less than 5 words as you can, like a professional poet.',
  'Incorrect Example:',
  'a. 解释一下JavaScript闭包到底是什么',
  'b. 用英语表达中国近代半文言文文法',
  'c. 中式微恐2.5D沙盒生存游戏系统PRD',
  'd. Fixing Memory Leak in Node',
  'e. Database Schema Design Review',
  'Correct Example:',
  'a. JS闭包浅说',
  'b. 半文言文文法表达',
  'c. 游戏PRD',
  'd. Node memory leak',
  'e. Schema review',
].join('\n')

/** 用 JSON 包裹消息，用户文本无法破坏结构分隔符（与官方一致）。 */
function frameMessages(messages) {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** 整行被星号强调包裹的形式，如 `**Title**`。 */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/**
 * 从模型输出取标题：第一个非空行，去掉整行的星号强调。
 * 模型偶尔无视单行要求，把标题放第一行、说明放后面。
 */
function titleFromOutput(text) {
  const line = text
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.marker
  const inner = groups?.inner
  return marker === void 0 || inner === void 0 || inner.includes(marker) ? line : inner
}

/**
 * 拒绝 tool-call 与 max-tokens 终止，并从文本块推出非空标题。
 * @param response - executeSessionTitleLlm 的返回值：文本块、终止原因与实际路由。
 * @returns 归一化后的单行标题。
 */
function titleFromResponse(response) {
  switch (response.finish.kind) {
    case 'stop':
      break
    case 'tool-calls':
      throw new Error('session-title-llm: title output must contain text only')
    case 'max-tokens':
      throw new Error('session-title-llm: title output reached maxOutputTokens')
    default:
      throw new Error(`session-title-llm: unexpected finish ${JSON.stringify(response.finish)}`)
  }
  if (response.blocks.some((block) => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const title = normalizeSessionTitle(
    titleFromOutput(
      response.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' '),
    ),
    Number.MAX_SAFE_INTEGER,
  )
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return title
}

/** 选择路由支持的最低推理档位（与官方一致）。 */
const selectReasoningEffort = (model) => model.reasoning?.efforts[0]?.id

/** Loader 在 apply 之前用它校验并补全 entry config。 */
export const Config = z.object({
  maxInputBytes: z.number().step(1).min(1).default(DEFAULTS.maxInputBytes),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.maxOutputTokens),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULTS.timeoutMs),
  provider: z.string(),
  model: z.string(),
})

/**
 * 把入口配置补成共享解析器要求的完整形状。
 *
 * resolveSessionTitleLlmConfig() 会拒绝未知键，所以这里只传它认识的五个键：
 * 旧版附加的 targetWords / targetCjkCharacters 在 0.2.1 会直接报错。
 * @param config - Loader 已校验的入口配置，可能省略数值项。
 * @returns 冻结的完整执行控制配置。
 */
function completeConfig(config) {
  const value = config ?? {}
  return {
    maxInputBytes: value.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxOutputTokens: value.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    timeoutMs: value.timeoutMs ?? DEFAULTS.timeoutMs,
    provider: value.provider,
    model: value.model,
  }
}

/**
 * 注册 first-prompt 提供方：选择第一条人类消息，其余交给官方共享实现。
 * @param ctx - 插件上下文。
 * @param config - 入口配置。
 */
export function apply(ctx, config) {
  const resolved = resolveSessionTitleLlmConfig(completeConfig(config))
  const titleProvider = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'first-prompt',
    /**
     * @param request - 会话、可选路由、消息快照、当前标题与取消信号。
     * @returns 标题、来源 seq 与实际使用的模型路由。
     */
    async generate(request) {
      const first = request.messages[0]
      if (first === undefined) {
        throw new Error('first-prompt title provider requires one human message')
      }
      const response = await executeSessionTitleLlm(ctx, resolved, request, titleProvider, {
        system: SYSTEM_PROMPT,
        input: frameMessages([first]),
        messageSeqs: [first.seq],
        selectReasoningEffort,
      })
      return {
        title: titleFromResponse(response),
        messageSeqs: [first.seq],
        model: response.model,
      }
    },
  })
}
