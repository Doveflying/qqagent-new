/** OPT-01: isolated reply-pipeline regression; no real config, network or disk database. */
import pino from 'pino';
import { AppConfigSchema, PersonaSchema } from '../../src/core/types.js';
import type { AppConfig, ChatMessage, InboundMessage, LlmRoleName } from '../../src/core/types.js';
import { ProviderManager } from '../../src/llm/manager.js';
import { MemoryStore } from '../../src/memory/store.js';
import type { MemoryRetriever } from '../../src/memory/retriever.js';
import { MemoryRetriever as RealRetriever } from '../../src/memory/retriever.js';
import { ContextBuilder } from '../../src/context/compressor.js';
import { PersonaManager } from '../../src/persona/manager.js';
import { TriggerPolicy } from '../../src/persona/trigger.js';
import { EmotionAnalyzer } from '../../src/emotion/analyzer.js';
import { ReplyDispatcher } from '../../src/pipeline/dispatch.js';
import { ReplyPipeline } from '../../src/pipeline/reply.js';
import type { OneBotAction } from '../../src/napcat/action.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface Scenario {
  name: string;
  chat?: { provider?: string; model?: string };
  vision?: { provider?: string; model?: string };
  image?: boolean;
  visualProviders?: string[];
  brokenVision?: boolean;
  expectedProvider: string;
  expectedModel?: string;
  expectedImages?: number;
  expectVisionNote?: boolean;
  /** 用真实的 MemoryRetriever（默认是返回空结果的桩），配合 facts/history 做 prompt 级回放 */
  realRetriever?: boolean;
  /** 预置长期事实，用于验证记忆是否真的进了 prompt */
  facts?: Array<{ content: string; factType?: string; shareable?: boolean }>;
  /** 预置历史消息（按顺序），用于验证窗口截断 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 覆盖人格设定文本 */
  personaPrompt?: string;
}

export const scenarios: Scenario[] = [
  { name: 'explicit chat override', chat: { provider: 'chat', model: 'chat-model' }, expectedProvider: 'chat', expectedModel: 'chat-model' },
  { name: 'empty chat inherits defaults', expectedProvider: 'default', expectedModel: 'default-model' },
  { name: 'model-only override inherits provider', chat: { model: 'custom-model' }, expectedProvider: 'default', expectedModel: 'custom-model' },
  { name: 'provider-only override selects its own first model', chat: { provider: 'chat' }, expectedProvider: 'chat' },
  { name: 'default-provider override inherits default model', chat: { provider: 'default' }, expectedProvider: 'default', expectedModel: 'default-model' },
  { name: 'explicit vision still takes precedence for images', chat: { provider: 'chat', model: 'chat-model' }, vision: { provider: 'vision', model: 'vision-model' }, image: true, visualProviders: ['vision'], expectedProvider: 'vision', expectedModel: 'vision-model', expectedImages: 1 },
  { name: 'nonvisual vision falls back to visual chat role', chat: { provider: 'chat', model: 'chat-model' }, vision: { provider: 'vision', model: 'text-model' }, image: true, visualProviders: ['chat'], expectedProvider: 'chat', expectedModel: 'chat-model', expectedImages: 1 },
  { name: 'unconfigured vision falls back to visual chat role', chat: { provider: 'chat', model: 'chat-model' }, image: true, visualProviders: ['chat'], expectedProvider: 'chat', expectedModel: 'chat-model', expectedImages: 1 },
  { name: 'unresolvable vision falls back to visual chat role', chat: { provider: 'chat', model: 'chat-model' }, vision: { provider: 'vision', model: 'missing' }, brokenVision: true, image: true, visualProviders: ['chat'], expectedProvider: 'chat', expectedModel: 'chat-model', expectedImages: 1 },
  { name: 'no visual model keeps chat and explains missing image', chat: { provider: 'chat', model: 'chat-model' }, vision: { provider: 'vision', model: 'text-model' }, image: true, expectedProvider: 'chat', expectedModel: 'chat-model', expectedImages: 0, expectVisionNote: true },
  { name: 'provider-only visual chat resolves its own first model', chat: { provider: 'chat' }, image: true, visualProviders: ['chat'], expectedProvider: 'chat', expectedModel: 'chat-first', expectedImages: 1 },
];

export function makeFixture(scenario: Scenario, scope: string) {
  const cfg: AppConfig = AppConfigSchema.parse({
    persona: { default: 'test' },
    scheduling: { shortMessageMergeMs: 0 },
    media: { visionPipeline: false },
    llm: {
      defaultProvider: 'default', defaultModel: 'default-model',
      roles: { chat: scenario.chat ?? {}, vision: scenario.vision ?? {} },
    },
    emotion: { enabled: false },
    memory: { factExtraction: false, summary: { enabled: false } },
    trigger: { group: { cooldownMs: 0 } },
    reply: { recentImages: 2 },
    proactive: { imageLookback: 2, quietHours: [] },
  });
  const logs: Array<Record<string, unknown>> = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => { logs.push(JSON.parse(line)); } });
  const calls: Array<{ provider: string; model: string | undefined; messages: ChatMessage[] }> = [];
  const roles: LlmRoleName[] = [];
  // Reuse real role inheritance without ProviderManager's disk cache/discovery side effects.
  const providers = Object.create(ProviderManager.prototype) as ProviderManager;
  Object.defineProperty(providers, 'llmCfg', { value: cfg.llm });
  providers.resolveRole = (role, config) => {
    roles.push(role);
    return ProviderManager.prototype.resolveRole.call(providers, role, config);
  };
  providers.resolveModel = async (providerKey, modelId) => {
    if (scenario.brokenVision && providerKey === 'vision') throw new Error('synthetic missing vision model');
    return {
      providerKey, providerName: providerKey, modelId: modelId || `${providerKey}-first`,
      modelName: modelId || `${providerKey}-first`, protocol: 'openai',
      contextWindow: 32768, supportsStream: true,
      supportsVision: scenario.visualProviders?.includes(providerKey) ?? false,
    };
  };
  providers.streamChat = async (messages, provider, model) => {
    calls.push({ provider, model, messages });
    return {
      content: '合成测试回复', provider, model: model || `${provider}-first`,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latencyMs: 1,
    };
  };
  const store = new MemoryStore(':memory:');
  const persona = PersonaSchema.parse({ id: 'test', name: '测试', systemPrompt: scenario.personaPrompt ?? '测试人格' });
  // 预置数据：prompt 级回放要靠它们验证「记忆和历史有没有正确进 prompt」
  for (const fact of scenario.facts ?? []) {
    store.addFact({
      userId: 1,
      scope,
      factType: fact.factType ?? 'preference',
      content: fact.content,
      shareable: fact.shareable,
    });
  }
  for (const h of scenario.history ?? []) {
    store.addMessage({ scope, userId: h.role === 'user' ? 1 : 0, role: h.role, content: h.content });
  }
  const retriever = scenario.realRetriever
    ? (new RealRetriever(store, cfg.memory, log) as unknown as MemoryRetriever)
    : ({
        retrieveMerged: async () => ({ facts: [], summaries: [], hitIds: [], stats: { localFacts: 0, sharedFacts: 0, summaries: 0, query: '' } }),
      } as unknown as MemoryRetriever);
  const pipeline = new ReplyPipeline(
    cfg, store, providers, new PersonaManager([persona], cfg, store, log),
    new TriggerPolicy(cfg.trigger, log), new EmotionAnalyzer('rule', null, '', '', log),
    new ContextBuilder(cfg.context, cfg.memory, store, log), retriever, null,
    new ReplyDispatcher(cfg.reply, log), null, log,
  );
  let sends = 0;
  const api = { sendToScope: async () => ({ message_id: ++sends }) } as unknown as OneBotAction;
  const msg: InboundMessage = {
    scope, scopeType: scope.startsWith('group:') ? 'group' : 'private',
    ...(scope.startsWith('group:') ? { groupId: 123 } : {}),
    userId: 1, selfId: 999, messageId: 10, text: '这是什么',
    segments: [
      { type: 'text', data: { text: '这是什么' } },
      ...(scenario.image ? [{ type: 'image', data: { file: `base64://${PNG}` } }] : []),
    ],
    mentionsBot: true, senderName: '测试用户', timestamp: Date.now(), raw: {} as never,
  };
  return { cfg, store, providers, calls, roles, logs, pipeline, api, msg, sends: () => sends };
}

