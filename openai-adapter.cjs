'use strict';

// Pure request/response translation plus an injectable HTTP transport.
// No CRM, database, scheduler, or customer-message side effects.
class AIError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

function romeoFormat() {
  const nullable={type:['string','null']};
  const properties={reply:{type:'string'},should_reply:{type:'boolean'},
    warmth:{type:'string',enum:['cold','warm','hot']},lead_type:{type:'string',enum:['student','partner','insider','equipment']},
    content_interest:nullable,photos_course:nullable,summary:nullable,
    manager:{type:'string',enum:['samarina','kashinskiy']},language:{type:'string'},handoff:{type:'boolean'},phone:nullable,
    comment_intent:{type:['string','null'],enum:['demand','praise','none',null]},email:nullable,client_name:nullable,lead_source:nullable,
    stage_hint:{type:'string',enum:['in_dialog','hot','no_money','none']},send_route:{type:'boolean'}};
  return {type:'json_schema',name:'romeo_reply_v1',strict:true,schema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}};
}

function textBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new AIError('INVALID_TEXT', 400);
  return value.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw new AIError('UNSUPPORTED_CONTENT_BLOCK', 400);
    }
    if (Object.keys(block).some(k => !['type', 'text', 'cache_control'].includes(k))) {
      throw new AIError('UNSUPPORTED_TEXT_OPTION', 400);
    }
    return block.text;
  }).join('\n\n');
}

function toResponses(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AIError('INVALID_BODY', 400);
  const allowed = ['model', 'system', 'messages', 'max_tokens'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new AIError('UNSUPPORTED_REQUEST_OPTION', 400);
  if (!Array.isArray(body.messages) || !body.messages.length) throw new AIError('EMPTY_MESSAGES', 400);
  if (config.model !== 'gpt-6.1-sol') throw new AIError('MODEL_NOT_APPROVED', 500);
  if (!['low', 'medium', 'high'].includes(config.reasoningEffort)) throw new AIError('INVALID_REASONING', 500);
  const maxTokens = config.maxOutputTokens ?? body.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new AIError('INVALID_OUTPUT_LIMIT', 400);
  const input = body.messages.map(message => {
    if (!['user', 'assistant'].includes(message.role)) throw new AIError('UNSUPPORTED_ROLE', 400);
    if (Object.keys(message).some(k => !['role', 'content'].includes(k))) throw new AIError('UNSUPPORTED_MESSAGE_OPTION', 400);
    return { role: message.role, content: textBlocks(message.content) };
  });
  const instructions=body.system === undefined ? '' : textBlocks(body.system);
  const isRomeo=instructions.includes('# ФОРМАТ ОТВЕТА') && instructions.includes('"should_reply"') && instructions.includes('"send_route"');
  return {
    model: config.model,
    instructions,
    input,
    max_output_tokens: maxTokens,
    reasoning: { effort: config.reasoningEffort },
    text: { verbosity: 'low', ...(isRomeo ? {format:romeoFormat()} : instructions.startsWith('SOCRATES_RECORDS_V2') ? {format:require('./socrates/parser.cjs').format()} : {}) },
    store: false,
  };
}

function fromResponses(response) {
  if (response?.status !== 'completed') { const reason=response?.incomplete_details?.reason; throw new AIError('AI_RESPONSE_NOT_COMPLETED'+(['max_output_tokens','content_filter'].includes(reason)?'_'+reason.toUpperCase():'')); }
  const texts = [];
  for (const item of response.output || []) {
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed') {
      throw new AIError('UNEXPECTED_AI_OUTPUT');
    }
    for (const block of item.content || []) {
      if (block.type === 'refusal') throw new AIError('AI_REFUSAL');
      if (block.type !== 'output_text' || typeof block.text !== 'string') throw new AIError('UNEXPECTED_AI_CONTENT');
      texts.push(block.text);
    }
  }
  const text = texts.join('\n');
  if (!text.trim()) throw new AIError('EMPTY_AI_RESPONSE');
  const usage = response.usage || {};
  // Keep the content envelope consumed by the existing n8n and server parsers.
  return {
    id: response.id, type: 'message', role: 'assistant', model: response.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0 },
    openai_usage: usage,
  };
}

async function generate(body, config, { fetchImpl = globalThis.fetch, apiKey, timeoutMs = 120000 } = {}) {
  const request = toResponses(body, config);
  if (!apiKey) throw new AIError('OPENAI_KEY_MISSING', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      // Do not forward provider error bodies: they may echo private input.
      throw new AIError('OPENAI_HTTP_' + response.status, response.status === 429 ? 429 : 502);
    }
    let result;
    try { result = await response.json(); }
    catch { throw new AIError('INVALID_PROVIDER_JSON'); }
    return fromResponses(result);
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError(controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR', 502);
  } finally { clearTimeout(timer); }
}

module.exports = { AIError, toResponses, fromResponses, generate };
