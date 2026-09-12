/**
 * dsh-brief-session-title —— 极简会话标题插件。
 *
 * 与官方 @deepseek-ai/dsh-session-title-first-prompt-llm 的差异只有系统提示词；
 * 其余策略逐条对齐官方共享模块 @deepseek-ai/dsh-session-title-llm（0.1.5-rc.2）：
 *  - 同样的 JSON 帧格式、字节上限检查、tool-call 拒绝、空标题拒绝；
 *  - 同样的 deadline() + SESSION_TITLE_TIMEOUT 超时语义（超时原因码可判别）；
 *  - 同样在模型分发前写入 session/title-llm-request 日志事件；
 *  - 同样拒绝未知配置键、逐字段校验数值、deepFreeze 请求封套。
 *
 * 配置（cordis.patch.yml 的 entry config，省略时用 Config 里的默认值）：
 *  - maxInputBytes:   输入 JSON 帧的字节上限，默认 4096
 *  - maxOutputTokens: 标题请求输出 token 上限，默认 64
 *  - timeoutMs:       单次标题请求超时（毫秒），默认 60000，上限 2147483647
 *  - provider / model: 可选，同时给出时用独立路由生成标题；
 *                      省略则复用当前会话主请求的路由
 *
 * 互斥约定：官方 first-prompt 插件与本插件只能开一个。profile 的
 * cordis.patch.yml 里 `disabled: true` 是第一道保险（让官方根本不加载）；
 * 本插件装载时再兜底接管一次。
 */

import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { normalizeSessionTitle, SessionTitleProviderId } from '@deepseek-ai/dsh-session-title';
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-brief-session-title';

/**
 * 声明的依赖服务就绪后才执行 apply，顺序不再取决于 profile patch 层的位置。
 * 缺了它，一旦加载顺序变化，apply 会在服务注册前跑，抛错即整棵插件树加载失败。
 */
export const inject = ['sessionTitle', 'llm'];

/** 默认值单点定义：Config 模式与 resolveConfig() 共用，避免两处漂移。 */
const DEFAULTS = Object.freeze({
  maxInputBytes: 4096,
  maxOutputTokens: 64,
  timeoutMs: 60000,
});

/** 全部已知配置键；未知键直接报错，避免拼错键名后静默退回默认值。 */
const CONFIG_KEYS = Object.freeze(['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'provider', 'model']);

/** Loader 在 apply 之前用它校验并补全 entry config。 */
export const Config = z.object({
  maxInputBytes: z.number().step(1).min(1).default(DEFAULTS.maxInputBytes),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.maxOutputTokens),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULTS.timeoutMs),
  provider: z.string(),
  model: z.string(),
});

/**
 * 与官方 @deepseek-ai/dsh-session-title-llm 的 SESSION_TITLE_TIMEOUT_CODE 同值。
 * 超时由 deadline() 以 TimeoutReason 中止，message 形如
 * "SESSION_TITLE_TIMEOUT after 60000ms"，据此可把标题超时与用户取消区分开。
 */
const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT';

/**
 * 用户指定的极简标题提示词。
 *
 * 相对最初版本的两处修正：
 *  1. 保留官方的输出格式硬约束（no quotes / prefix / explanation / Markdown /
 *     XML / terminal control codes，no code）——这些不是客套话，normalizeSessionTitle()
 *     只清控制序列与方向控制字符，不会替你剥掉 Markdown 或引号；
 *  2. 正反例句都去掉包裹引号——原先把正例写成 a."JS闭包浅说"，模型会连引号一起模仿，
 *     实测 31 条标题里有 3 条带引号进侧边栏。
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
].join('\n');

/** 校验一个正整数配置项。 */
function assertPositiveInteger(field, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(name + ': ' + field + ' must be a positive integer');
  }
}

/**
 * 校验并冻结配置：拒绝未知键、逐字段验数值、provider/model 必须成对。
 * Loader 已经跑过 Config，这里保证直接调用 apply(ctx, {}) 时行为一致。
 * @param config - 未经校验的插件配置，可为 undefined。
 * @returns 补全默认值后的冻结配置。
 */
function resolveConfig(config) {
  const value = config ?? {};
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.includes(key)) throw new Error(name + ': unknown config key "' + key + '"');
  }
  const resolved = {
    maxInputBytes: value.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxOutputTokens: value.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    timeoutMs: value.timeoutMs ?? DEFAULTS.timeoutMs,
    provider: value.provider,
    model: value.model,
  };
  assertPositiveInteger('maxInputBytes', resolved.maxInputBytes);
  assertPositiveInteger('maxOutputTokens', resolved.maxOutputTokens);
  assertPositiveInteger('timeoutMs', resolved.timeoutMs);
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(name + ': timeoutMs must not exceed ' + MAX_TIMER_DELAY_MS);
  }
  const hasProvider = resolved.provider !== undefined;
  if (hasProvider !== (resolved.model !== undefined)) {
    throw new Error(name + ': provider and model must be supplied together');
  }
  if (hasProvider && (typeof resolved.provider !== 'string' || resolved.provider.length === 0
    || typeof resolved.model !== 'string' || resolved.model.length === 0)) {
    throw new Error(name + ': provider and model must be non-empty strings');
  }
  return deepFreeze(resolved);
}

/**
 * 注册 first-prompt 标题 provider。
 * @param ctx - 提供 sessionTitle 与 llm 服务的上下文。
 * @param config - Loader 校验过的 entry config。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const titleService = ctx.sessionTitle;
  const llm = ctx.llm;

  ensureExclusive(titleService);

  const providerId = SessionTitleProviderId(name);

  titleService.register({
    id: providerId,
    automatic: 'first-prompt',
    generate: async (request) => {
      const first = request.messages[0];
      if (first === undefined) {
        throw new Error(name + ': first-prompt title provider requires one human message');
      }
      request.signal.throwIfAborted();

      const framedInput = 'Generate the session title from this JSON array of human messages:\n'
        + JSON.stringify([first]);
      const inputBytes = Buffer.byteLength(framedInput, 'utf8');
      if (inputBytes > cfg.maxInputBytes) {
        throw new Error(name + ': input is ' + inputBytes + ' bytes, exceeding maxInputBytes ' + cfg.maxInputBytes);
      }

      const route = resolveRoute(cfg, request);
      const callDeadline = deadline(request.signal, cfg.timeoutMs, SESSION_TITLE_TIMEOUT_CODE);
      try {
        const messages = [createUserMessage({
          content: [{ type: 'text', text: framedInput }],
          source: { kind: 'plugin', plugin: name },
        })];
        const options = deepFreeze({
          provider: route.provider,
          model: route.model,
          messages,
          system: SYSTEM_PROMPT,
          maxTokens: cfg.maxOutputTokens,
          sessionId: request.session.id,
          purpose: 'session-title',
          signal: callDeadline.signal,
        });

        // 模型可见即必须可重建：辅助标题请求在分发前留痕，会话日志据此还原
        // 这次调用的提示词、路由与 token 上限。
        request.session.append('session/title-llm-request', {
          titleProvider: providerId,
          messageSeqs: [first.seq],
          route,
          system: SYSTEM_PROMPT,
          messages,
          maxTokens: cfg.maxOutputTokens,
        });

        callDeadline.signal.throwIfAborted();
        const assembler = new BlockAssembler();
        for await (const chunk of llm.stream(options)) {
          callDeadline.signal.throwIfAborted();
          assembler.push(chunk);
        }
        callDeadline.signal.throwIfAborted();

        const terminal = finishError(assembler.finish);
        if (terminal !== undefined) throw terminal;

        const blocks = assembler.blocks();
        if (blocks.some((block) => block.type === 'tool-call')) {
          throw new Error(name + ': title output must contain text only');
        }
        const text = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ');
        // 与官方一致：此处不按字节截断，交给 service 用 maxTitleBytes 统一裁。
        const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER);
        if (title.length === 0) throw new Error(name + ': title model produced no text');

        return { title, messageSeqs: [first.seq], model: route };
      } finally {
        callDeadline[Symbol.dispose]();
      }
    },
  });
}

/**
 * 官方 first-prompt 插件与本插件只能有一个注册到 sessionTitle。
 * profile 的 cordis.patch.yml 里 `disabled: true` 是主要机制，这里只是兜底。
 *
 * 注意：下面读写的 `registration` 是 SessionTitleService 的 TypeScript private 字段
 * （packages/session/session-title/src/index.ts:271），属于上游实现细节。0.1.5-rc.2 的
 * 编译产物里它是普通实例属性，所以现在可用；一旦上游改名或改成 #registration，
 * 这里会静默失配，随后 register() 撞上服务自己的守卫抛错，导致插件树加载失败。
 * 因此：不要删掉 patch 里的 `disabled: true`。
 * @param titleService - sessionTitle 服务实例。
 */
function ensureExclusive(titleService) {
  const previous = titleService.registration;
  if (previous === undefined) return;
  previous.closing = true;
  titleService.registration = undefined;
  console.info('[' + name + '] 检测到官方标题 provider 已注册，已关闭并由本插件接管');
}

/**
 * 解析标题请求使用的模型路由：配置优先，否则复用会话主请求路由。
 * @param cfg - 已解析的配置。
 * @param request - service 传入的 provider 请求。
 * @returns 明确 provider 与 model 的路由。
 */
function resolveRoute(cfg, request) {
  if (cfg.provider !== undefined && cfg.model !== undefined) {
    return { provider: cfg.provider, model: cfg.model };
  }
  if (request.route === undefined) {
    throw new Error(name + ': no logged request route is available; configure provider and model together');
  }
  return request.route;
}

/**
 * 把模型的结束原因翻译成错误；正常 stop 返回 undefined。
 * @param finish - BlockAssembler 的结束原因。
 * @returns 对应的 Error，或 undefined 表示正常结束。
 */
function finishError(finish) {
  switch (finish?.kind) {
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? (name + ': title request ended abnormally'));
      error.code = finish.failure?.code;
      return error;
    }
    case 'max-tokens':
      return new Error(name + ': title output reached maxOutputTokens');
    case 'tool-calls':
      return new Error(name + ': title model unexpectedly requested a tool');
    default:
      return new Error(name + ': unsupported finish reason "' + String(finish?.kind) + '"');
  }
}
