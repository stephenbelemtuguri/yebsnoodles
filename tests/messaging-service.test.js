const { normalizePhone, sendWhatsApp } = require('../src/services/messaging');
const smsService = require('../src/services/sms');

describe('YEBS messaging service', () => {
  test.each([
    ['0241234567', '233241234567'],
    ['+233 24 123 4567', '233241234567'],
    ['442071838750', '442071838750'],
    ['12', '']
  ])('normalizes %s safely', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test('does not make a provider request when WhatsApp is not configured', async () => {
    const fetchImpl = jest.fn();
    const result = await sendWhatsApp('0241234567', 'Hello', {}, fetchImpl);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/not configured/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sends a WhatsApp Cloud message and returns the provider message ID', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.test-message' }] })
    });
    const result = await sendWhatsApp('0241234567', 'Order update', {
      WHATSAPP_TOKEN: 'test-token',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
      WHATSAPP_API_VERSION: 'v20.0'
    }, fetchImpl);

    expect(result).toMatchObject({
      success: true,
      provider: 'whatsapp-cloud',
      providerId: 'wamid.test-message',
      to: '233241234567'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v20.0/123456789/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: expect.stringContaining('"body":"Order update"')
      })
    );
  });

  test('returns provider rejection as an explicit delivery failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Template required outside the service window.' } })
    });
    const result = await sendWhatsApp('0241234567', 'Hello', {
      WHATSAPP_TOKEN: 'test-token',
      WHATSAPP_PHONE_NUMBER_ID: '123456789'
    }, fetchImpl);
    expect(result).toMatchObject({
      success: false,
      error: 'Template required outside the service window.'
    });
  });

  describe('Arkesel SMS provider', () => {
    const originalApiKey = process.env.ARKESEL_API_KEY;
    const originalLegacyApiKey = process.env.ARKSEL_API_KEY;
    const originalSenderId = process.env.ARKESEL_SENDER_ID;
    const originalLegacySenderId = process.env.ARKSEL_SENDER_ID;
    const originalFetch = global.fetch;

    afterEach(() => {
      if (originalApiKey === undefined) delete process.env.ARKESEL_API_KEY;
      else process.env.ARKESEL_API_KEY = originalApiKey;
      if (originalLegacyApiKey === undefined) delete process.env.ARKSEL_API_KEY;
      else process.env.ARKSEL_API_KEY = originalLegacyApiKey;
      if (originalSenderId === undefined) delete process.env.ARKESEL_SENDER_ID;
      else process.env.ARKESEL_SENDER_ID = originalSenderId;
      if (originalLegacySenderId === undefined) delete process.env.ARKSEL_SENDER_ID;
      else process.env.ARKSEL_SENDER_ID = originalLegacySenderId;
      global.fetch = originalFetch;
    });

    test('sends through Arkesel with the API-key header and expected Ghana recipient format', async () => {
      process.env.ARKESEL_API_KEY = 'test-arkesel-key';
      process.env.ARKESEL_SENDER_ID = 'YEBS';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: 'test-message-id' })
      });

      const result = await smsService.sendViaArkesel('+233241234567', 'Order update');

      expect(result).toMatchObject({
        success: true,
        provider: 'arkesel',
        to: '+233241234567',
        messageId: 'test-message-id'
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://sms.arkesel.com/api/v2/sms/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'api-key': 'test-arkesel-key', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: 'YEBS',
            message: 'Order update',
            recipients: ['233241234567']
          })
        })
      );
    });

    test('does not request Arkesel when its API key is missing', async () => {
      delete process.env.ARKESEL_API_KEY;
      delete process.env.ARKSEL_API_KEY;
      global.fetch = jest.fn();

      const result = await smsService.sendViaArkesel('+233241234567', 'Order update');

      expect(result).toMatchObject({ success: false, error: 'Arkesel API key not configured' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
