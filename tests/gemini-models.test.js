const { clearGeminiModelCache, listAvailableGeminiModels } = require('../src/services/geminiModels');

describe('Gemini model discovery', () => {
  beforeEach(() => clearGeminiModelCache());

  test('paginates models, filters unsupported media models, and prioritizes text Flash models', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] }
          ],
          nextPageToken: 'next-page'
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
          ]
        })
      });

    const models = await listAvailableGeminiModels('test-api-key', fetchImpl);

    expect(models).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('pageToken=next-page');
  });

  test('uses the cached catalog for the same key without another provider request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
      })
    });

    await listAvailableGeminiModels('test-api-key', fetchImpl);
    const second = await listAvailableGeminiModels('test-api-key', fetchImpl);

    expect(second).toEqual(['gemini-2.5-flash']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
