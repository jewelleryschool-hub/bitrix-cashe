'use strict';
const crypto = require('node:crypto');
const { generate, AIError } = require('./openai-adapter.cjs');

function provider(env) {
  const value = env.AI_PROVIDER || 'anthropic';
  if (!['anthropic', 'openai'].includes(value)) throw new AIError('INVALID_AI_PROVIDER', 503);
  return value;
}

function aiCredential(env = process.env) {
  return provider(env) === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
}

function authorizeAIRequest(key, env = process.env) {
  if (typeof key !== 'string' || !key) return false;
  if (provider(env) !== 'openai') return true; // Preserve legacy behavior until explicit switch.
  const hashes = (env.AI_GATEWAY_KEY_SHA256 || '').split(',').map(s => s.trim()).filter(s => /^[a-f0-9]{64}$/.test(s));
  const digest = crypto.createHash('sha256').update(key).digest();
  return hashes.some(hash => crypto.timingSafeEqual(digest, Buffer.from(hash, 'hex')));
}

async function aiFetch(url, options, env = process.env, fetchImpl = globalThis.fetch) {
  if (url !== 'https://api.anthropic.com/v1/messages') throw new AIError('INVALID_AI_ENDPOINT', 500);
  if (provider(env) === 'anthropic') {
    const legacy = { ...options };
    if (legacy.timeout && !legacy.signal) legacy.signal = AbortSignal.timeout(legacy.timeout);
    delete legacy.timeout;
    return fetchImpl(url, legacy);
  }
  try {
    const body = JSON.parse(options.body);
    const result = await generate(body, {
      model: env.OPENAI_MODEL || 'gpt-6.1-sol',
      reasoningEffort: env.OPENAI_REASONING_EFFORT || 'medium',
      ...(env.OPENAI_MAX_OUTPUT_TOKENS ? {maxOutputTokens: Number(env.OPENAI_MAX_OUTPUT_TOKENS)} : {}),
    }, { apiKey: env.OPENAI_API_KEY, timeoutMs: options.timeout || 120000, fetchImpl });
    return { ok: true, status: 200, json: async () => result };
  } catch (error) {
    const safe = error instanceof AIError ? error : new AIError('INVALID_AI_REQUEST', 400);
    return { ok: false, status: safe.status, json: async () => ({ type: 'error', error: { type: 'ai_provider_error', message: safe.code } }) };
  }
}
module.exports = { aiCredential, authorizeAIRequest, aiFetch };
