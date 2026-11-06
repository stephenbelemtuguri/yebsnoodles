const { parseSelfieFrames } = require('../src/services/driverFaceVerification');

describe('driver face recovery frame validation', () => {
  test('validates each captured selfie frame independently', () => {
    const image = `data:image/jpeg;base64,${Buffer.from('test-frame').toString('base64')}`;

    expect(parseSelfieFrames([image, image, image])).toEqual([
      Buffer.from('test-frame'),
      Buffer.from('test-frame'),
      Buffer.from('test-frame')
    ]);
  });

  test('rejects malformed or oversized selfie frames', () => {
    const oversizedImage = `data:image/jpeg;base64,${Buffer.alloc(500_001).toString('base64')}`;

    expect(() => parseSelfieFrames(['not-an-image', 'not-an-image', 'not-an-image'])).toThrow(/supported base64 image/i);
    expect(() => parseSelfieFrames([oversizedImage, oversizedImage, oversizedImage])).toThrow(/too large/i);
  });
});
