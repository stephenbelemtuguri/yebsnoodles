class SMSService {
  constructor() {
    this.providerOrder = ['arkesel', 'hubtel', 'twilio'];
  }

  formatGhanaNumber(phone) {
    const cleaned = String(phone || '').replace(/\s+|-/g, '').replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+233')) return cleaned;
    if (cleaned.startsWith('233')) return '+' + cleaned;
    if (cleaned.startsWith('0')) return '+233' + cleaned.substring(1);
    if (cleaned.length === 9) return '+233' + cleaned;
    return cleaned;
  }

  async send(to, message) {
    const formattedNumber = this.formatGhanaNumber(to);
    const text = String(message || '').trim().slice(0, 1500);
    if (!formattedNumber || !text) return { success: false, error: 'Phone number and message are required' };
    for (const provider of this.providerOrder) {
      try {
        const result = await this[`sendVia${this.capitalize(provider)}`](formattedNumber, text);
        if (result.success) return result;
        console.warn(`[SMS:${provider}] ${result.error}`);
      } catch (error) {
        console.warn(`[SMS:${provider}] ${error.message}`);
      }
    }
    return { success: false, error: 'All SMS providers failed', message: `Failed to send SMS to ${formattedNumber}` };
  }

  async sendViaArkesel(to, message) {
    const apiKey = process.env.ARKSEL_API_KEY;
    const senderId = process.env.ARKSEL_SENDER_ID || 'YEBS';
    if (!apiKey) return { success: false, error: 'Arkesel API key not configured' };
    const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: senderId, message, recipients: [to.replace(/^\+/, '')] })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status === 'failed') throw new Error(payload.message || payload.status || `Arkesel HTTP ${response.status}`);
    return { success: true, provider: 'arkesel', to, messageId: payload.data || payload.id || null };
  }

  async sendViaHubtel(to, message) {
    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    if (!clientId || !clientSecret) return { success: false, error: 'Hubtel credentials not configured' };
    const response = await fetch('https://smsc.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        From: process.env.HUBTEL_SENDER_ID || 'YEBS',
        To: [to],
        Content: message,
        RegisteredDelivery: true
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status === 'Failed') throw new Error(payload.message || payload.status || `Hubtel HTTP ${response.status}`);
    return { success: true, provider: 'hubtel', to, messageId: payload.messageId || payload.message_id || null };
  }

  async sendViaTwilio(to, message) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER;
    if (!accountSid || !authToken) return { success: false, error: 'Twilio credentials not configured' };
    if (!from) return { success: false, error: 'Twilio sender number not configured' };
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: from, Body: message })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Twilio HTTP ${response.status}`);
    return { success: true, provider: 'twilio', to, messageId: payload.sid || null };
  }

  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

module.exports = new SMSService();
