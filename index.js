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
 * 做法：本插件向 ctx.sessionTitle 注册一个 first-prompt 提供方，在 generate()
 * 里调用官方的 generateSessionTitleWithLlm()，只把两处系统提示词替换成本插件的：
 *  1. 真正发给模型的 system；
 *  2. 同一次调用写入 session/title-llm-request 日志的 system（模型可见 ⟺ 可重建，
 *     日志必须记录实际发送的提示词）。
 * 因此官方升级时，本插件不需要复制任何策略代码，只需跟随共享模块的函数签名。
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
} from '@deepseek-ai/dsh-session-title-llm'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
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

/** 官方 systemPrompt() 会读取这两个目标长度；本插件提示词写死了长度规则，
 *  这里只填入满足共享解析器校验的最小合法值。 */
const INERT_TARGETS = Object.freeze({ targetWords: 1, targetCjkCharacters: 1 })

/** 记录辅助标题调用的会话事件类型。 */
const TITLE_REQUEST_EVENT = 'session/title-llm-request'

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
 * @param config - Loader 已校验的入口配置，可能省略数值项。
 * @returns 含惰性目标长度字段的完整配置。
 */
function completeConfig(config) {
  const value = config ?? {}
  return {
    ...INERT_TARGETS,
    maxInputBytes: value.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxOutputTokens: value.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    timeoutMs: value.timeoutMs ?? DEFAULTS.timeoutMs,
    provider: value.provider,
    model: value.model,
  }
}

/**
 * 用自定义提示词包装 ctx：官方实现只通过 ctx.llm.stream() 发起调用。
 * @param ctx - 真实插件上下文。
 * @returns 仅替换 system 的上下文视图。
 */
function contextWithPrompt(ctx) {
  return new Proxy(ctx, {
    get(target, property) {
      if (property !== 'llm') return Reflect.get(target, property, target)
      return {
        stream(options) {
          return target.llm.stream({ ...options, system: SYSTEM_PROMPT })
        },
      }
    },
  })
}

/**
 * 让日志记录实际发送的提示词：官方实现会在 append 时写入它自己的 system。
 * @param request - 标题服务传入的请求（session、messages、可选 route、signal）。
 * @returns 仅改写 title-llm-request 日志字段的请求视图。
 */
function requestWithLoggedPrompt(request) {
  return {
    ...request,
    session: new Proxy(request.session, {
      get(target, property) {
        if (property !== 'append') return Reflect.get(target, property, target)
        return (type, data) => target.append(
          type,
          type === TITLE_REQUEST_EVENT ? { ...data, system: SYSTEM_PROMPT } : data,
        )
      },
    }),
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
     * @param request - 会话、可选路由、消息快照与取消信号。
     * @returns 标题、来源 seq 与实际使用的模型路由。
     */
    async generate(request) {
      const first = request.messages[0]
      if (first === undefined) {
        throw new Error('first-prompt title provider requires one human message')
      }
      return generateSessionTitleWithLlm(
        contextWithPrompt(ctx),
        resolved,
        requestWithLoggedPrompt(request),
        [first],
        titleProvider,
      )
    },
  })
}
