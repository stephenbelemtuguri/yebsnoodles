const smsService = require('./sms');

function normalizePhone(phone) {
  let digits = String(phone || '').trim().replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = `233${digits.slice(1)}`;
  if (digits.length === 9) digits = `233${digits}`;
  return /^\d{10,15}$/.test(digits) && digits[0] !== '0' ? digits : '';
}

async function sendWhatsApp(phone, message, env = process.env, fetchImpl = globalThis.fetch) {
  const to = normalizePhone(phone);
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

module.exports = { normalizePhone, sendWhatsApp, send };
