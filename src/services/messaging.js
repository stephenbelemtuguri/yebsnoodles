const smsService = require('./sms');

function normalizePhone(phone) {
  let digits = String(phone || '').trim().replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = `233${digits.slice(1)}`;
  if (digits.length === 9) digits = `233${digits}`;
  return /^\d{10,15}$/.test(digits) && digits[0] !== '0' ? digits : '';
}

function evolutionConfig(env) {
  const apiKey = String(env.EVOLUTION_API_KEY || '').trim();
  const instance = String(env.EVOLUTION_INSTANCE || '').trim();
  const rawUrl = String(env.EVOLUTION_API_URL || '').trim();
  if (!apiKey || !instance || !rawUrl) return null;

  let baseUrl;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    return { error: 'Evolution API URL is invalid.' };
  }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
  if ((baseUrl.protocol !== 'https:' && !(localHost && baseUrl.protocol === 'http:')) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    return { error: 'Evolution API URL must be a secure HTTPS base URL.' };
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(instance)}`;
  return { apiKey, endpoint: baseUrl.toString() };
}

function isEvolutionConfigured(env = process.env) {
  const config = evolutionConfig(env);
  return Boolean(config && !config.error);
}

async function sendEvolutionWhatsApp(phone, message, env = process.env, fetchImpl = globalThis.fetch) {
  const to = normalizePhone(phone);
  if (!to) return { success: false, error: 'Enter a valid phone number including its country code.' };
  const config = evolutionConfig(env);
  if (!config) return { success: false, error: 'Evolution API is not configured.' };
  if (config.error) return { success: false, error: config.error };

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: to, text: String(message || '').slice(0, 3800), linkPreview: false }),
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    return { success: false, error: String(error.message || 'Evolution API request failed.').slice(0, 300) };
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(payload.message) ? payload.message.join('; ') : payload.message;
    return {
      success: false,
      status: response.status,
      error: String(details || payload.error || `Evolution API returned HTTP ${response.status}`).slice(0, 300)
    };
  }
  const key = payload.key || payload.data && payload.data.key || {};
  return {
    success: true,
    provider: 'evolution-api',
    providerId: key.id || payload.messageId || payload.id || null,
    to
  };
}

async function sendWhatsApp(phone, message, env = process.env, fetchImpl = globalThis.fetch) {
  const to = normalizePhone(phone);
  const evolution = evolutionConfig(env);
  if (evolution) {
    const result = await sendEvolutionWhatsApp(phone, message, env, fetchImpl);
    if (result.success || !env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return result;
  }
  const token = env.WHATSAPP_TOKEN || env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_CLOUD_TOKEN || '';
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_ID || '';
  const version = env.WHATSAPP_API_VERSION || 'v20.0';
  if (!to) return { success: false, error: 'Enter a valid phone number including its country code.' };
  if (!token || !phoneId) return { success: false, error: 'YEBS WhatsApp Cloud API is not configured.' };
  if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(String(phoneId))) {
    return { success: false, error: 'WhatsApp Cloud API configuration is invalid.' };
  }

  const response = await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: String(message).slice(0, 3800) }
    }),
    signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error && payload.error.message;
    return {
      success: false,
      error: String(error || `WhatsApp Cloud API returned HTTP ${response.status}`).slice(0, 300)
    };
  }
  return {
    success: true,
    provider: 'whatsapp-cloud',
    providerId: payload.messages && payload.messages[0] ? payload.messages[0].id || null : null,
    to
  };
}

async function send(channel, phone, message) {
  if (channel === 'whatsapp') return sendWhatsApp(phone, message);
  if (channel === 'sms') {
    const result = await smsService.send(phone, message);
    return result.success
      ? { success: true, provider: result.provider, providerId: result.messageId || null, to: result.to }
      : { success: false, error: result.error || result.message || 'All configured SMS providers failed.' };
  }
  return { success: false, error: 'Choose WhatsApp or SMS.' };
}

module.exports = { normalizePhone, isEvolutionConfigured, sendEvolutionWhatsApp, sendWhatsApp, send };
