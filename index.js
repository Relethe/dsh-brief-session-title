/**
 * dsh-brief-session-title — 与官方 @deepseek-ai/dsh-session-title-first-prompt-llm
 * 逻辑完全一致的 first-prompt 标题插件，唯一区别：系统提示词换成极简风格。
 *
 * 其余部分不动：同样取第一条人类消息、同样走 ctx.llm 流式生成、
 * 同样记录 purpose: 'session-title'（DeepSeek 适配器据此关闭 thinking）、
 * 失败时同样回落到官方 session-title 服务的确定性兜底标题（fallback）。
 *
 * 配置（cordis.patch.yml entry config，均可省略）：
 *  - maxInputBytes:   输入 JSON 帧的字节上限，默认 4096
 *  - maxOutputTokens: 标题请求输出 token 上限，默认 64
 *  - timeoutMs:       单次标题请求超时（毫秒），默认 60000
 *  - provider / model: 可选，同时给出时用独立路由生成标题；
 *                      省略则复用当前会话主请求的路由
 *
 * 互斥约定：官方 first-prompt 插件与本插件只能开一个。本插件装载时会
 * 自动接管——若官方 provider 已注册，先清掉它再注册自己；官方插件
 * 自身代码不动。profile 的 cordis.patch.yml 里仍保留 `disabled: true`
 * 作为第一道保险（让官方根本不加载）。
 */

import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';

const PLUGIN = 'dsh-brief-session-title';

/** 用户指定的极简标题提示词，原样保留。 */
const SYSTEM_PROMPT = [
  'Generate a concise title for an AI coding-assistant session from the supplied human messages.',
  "Print with the principle of PLAIN ENGLISH if it's English.",
  "Print with the principle of literary-vernacular hybrid if it's Chinese.",
  'Follow the original language of the messages.',
  'Avoid using the verb of sentence in output.',
  'Shorten the length of output to less than 5 words as you can, like a professional poet.',
  'Return only the title on one line in raw plain text.',
  'Incorrect Example:',
  'a."解释一下JavaScript闭包到底是什么"',
  'b."用英语表达中国近代半文言文文法"',
  'c."中式微恐2.5D沙盒生存游戏系统PRD"',
  'd."Fixing Memory Leak in Node"',
  'e."Database Schema Design Review"',
  'Correct Example:',
  'a."JS闭包浅说"',
  'b."半文言文文法表达"',
  'c."游戏PRD"',
  'd."Node memory leak"',
  'e."Schema review"',
].join('\n');

export function apply(ctx, config = {}) {
  const cfg = {
    maxInputBytes: config.maxInputBytes ?? 4096,
    maxOutputTokens: config.maxOutputTokens ?? 64,
    timeoutMs: config.timeoutMs ?? 60000,
    provider: config.provider,
    model: config.model,
  };
  if ((cfg.provider === undefined) !== (cfg.model === undefined)) {
    throw new Error(`${PLUGIN}: provider and model must be supplied together`);
  }

  const titleService = ctx.get('sessionTitle');
  if (!titleService || typeof titleService.register !== 'function') {
    throw new Error(`${PLUGIN}: 未找到 sessionTitle 服务（缺少 @deepseek-ai/dsh-session-title）`);
  }
  const llm = ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error(`${PLUGIN}: 未找到 llm 服务`);
  }

  // 互斥：官方 provider 若已注册，先清掉再注册本插件（默认开自己、关官方）。
  ensureExclusive(titleService);

  titleService.register({
    id: PLUGIN,
    automatic: 'first-prompt',
    generate: async (request) => {
      const first = request.messages[0];
      if (first === undefined) {
        throw new Error(`${PLUGIN}: first-prompt title provider requires one human message`);
      }
      request.signal.throwIfAborted();

      const framedInput = `Generate the session title from this JSON array of human messages:\n${JSON.stringify([first])}`;
      const inputBytes = Buffer.byteLength(framedInput, 'utf8');
      if (inputBytes > cfg.maxInputBytes) {
        throw new Error(`${PLUGIN}: input is ${inputBytes} bytes, exceeding maxInputBytes ${cfg.maxInputBytes}`);
      }

      const route = resolveRoute(cfg, request);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(cfg.timeoutMs)]);

      const options = {
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: framedInput }],
          source: { kind: 'plugin', plugin: PLUGIN },
        })],
        system: SYSTEM_PROMPT,
        maxTokens: cfg.maxOutputTokens,
        sessionId: request.session.id,
        purpose: 'session-title',
        signal,
      };

      const assembler = new BlockAssembler();
      for await (const chunk of llm.stream(options)) {
        signal.throwIfAborted();
        assembler.push(chunk);
      }
      signal.throwIfAborted();

      const terminal = finishError(assembler.finish);
      if (terminal !== undefined) throw terminal;

      const blocks = assembler.blocks();
      if (blocks.some((block) => block.type === 'tool-call')) {
        throw new Error(`${PLUGIN}: title output must contain text only`);
      }
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER);
      if (title.length === 0) throw new Error(`${PLUGIN}: title model produced no text`);

      return {
        title,
        messageSeqs: [first.seq],
        model: route,
      };
    },
  });
}

/**
 * 官方 first-prompt 插件与本插件只能有一个注册到 sessionTitle。
 * 官方插件 apply 时丢弃了 register() 返回的 disposer，正常路径无法
 * 主动卸载它；这里直接清理服务上的运行时注册记录（TS 的 private 字段
 * 编译后仍是同名属性 `registration`），随后本插件接管注册。装载瞬间
 * 官方 provider 尚无进行中的生成任务，不会残留工作。
 * @param titleService - sessionTitle 服务实例
 */
function ensureExclusive(titleService) {
  const previous = titleService.registration;
  if (previous !== undefined) {
    previous.closing = true;
    titleService.registration = undefined;
    console.info(`[${PLUGIN}] 检测到官方标题 provider 已注册，已关闭并由本插件接管`);
  }
}

/** 解析标题请求使用的模型路由：配置优先，否则复用会话主请求路由。 */
function resolveRoute(cfg, request) {
  if (cfg.provider !== undefined && cfg.model !== undefined) {
    return { provider: cfg.provider, model: cfg.model };
  }
  if (request.route === undefined) {
    throw new Error(`${PLUGIN}: no logged request route is available; configure provider and model together`);
  }
  return request.route;
}

/** 把模型的结束原因翻译成错误；正常 stop 返回 undefined。 */
function finishError(finish) {
  switch (finish?.kind) {
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? `${PLUGIN}: title request ended abnormally`);
      error.code = finish.failure?.code;
      return error;
    }
    case 'max-tokens':
      return new Error(`${PLUGIN}: title output reached maxOutputTokens`);
    case 'tool-calls':
      return new Error(`${PLUGIN}: title model unexpectedly requested a tool`);
    default:
      return new Error(`${PLUGIN}: unsupported finish reason "${String(finish?.kind)}"`);
  }
}
