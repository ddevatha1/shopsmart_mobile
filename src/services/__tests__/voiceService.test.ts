import {
  createVoiceSession, getSpeechRecognitionProvider, getSpeechSynthesisProvider, setSpeechRecognitionProvider,
  setSpeechSynthesisProvider, UnavailableSpeechRecognizer, UnavailableSpeechSynthesizer, VoiceUnavailableError,
  type SpeechRecognizer, type SpeechSynthesizer,
} from '../voiceService';

describe('UnavailableSpeechRecognizer / UnavailableSpeechSynthesizer', () => {
  test('the default providers are the Unavailable* implementations out of the box', () => {
    expect(getSpeechRecognitionProvider()).toBeInstanceOf(UnavailableSpeechRecognizer);
    expect(getSpeechSynthesisProvider()).toBeInstanceOf(UnavailableSpeechSynthesizer);
  });

  test('startListening/stopListening reject with a real, well-known error rather than hanging or returning garbage', async () => {
    const recognizer = new UnavailableSpeechRecognizer();
    await expect(recognizer.startListening()).rejects.toThrow(VoiceUnavailableError);
    await expect(recognizer.stopListening()).rejects.toThrow('voice_unavailable');
  });

  test('speak() rejects, but stop() is a safe no-op even when unavailable', async () => {
    const synthesizer = new UnavailableSpeechSynthesizer();
    await expect(synthesizer.speak('hello')).rejects.toThrow(VoiceUnavailableError);
    await expect(synthesizer.stop()).resolves.toBeUndefined();
  });
});

describe('provider swapping', () => {
  afterEach(() => {
    setSpeechRecognitionProvider(new UnavailableSpeechRecognizer());
    setSpeechSynthesisProvider(new UnavailableSpeechSynthesizer());
  });

  test('setSpeechRecognitionProvider/setSpeechSynthesisProvider actually change what createVoiceSession uses by default', async () => {
    const fakeRecognizer: SpeechRecognizer = {
      startListening: jest.fn().mockResolvedValue(undefined),
      stopListening: jest.fn().mockResolvedValue('hello from a real provider'),
    };
    setSpeechRecognitionProvider(fakeRecognizer);

    const session = createVoiceSession(); // no explicit deps — uses the swapped provider
    await session.start();
    const transcript = await session.stop();

    expect(transcript).toBe('hello from a real provider');
    expect(fakeRecognizer.startListening).toHaveBeenCalled();
  });
});

describe('createVoiceSession — unavailable provider fallback (default deps)', () => {
  test('using the default (unavailable) providers, start/stop never throw and settle into a safe error state', async () => {
    const session = createVoiceSession();

    await expect(session.start()).resolves.toBeUndefined();
    const transcript = await session.stop();

    expect(transcript).toBe('');
    expect(session.status).toBe('error');
    expect(session.error).toBe('voice_unavailable');
  });
});

describe('createVoiceSession — state transitions', () => {
  function fakeDeps(overrides: Partial<{ recognizer: Partial<SpeechRecognizer>; synthesizer: Partial<SpeechSynthesizer> }> = {}) {
    return {
      recognizer: {
        startListening: jest.fn().mockResolvedValue(undefined),
        stopListening: jest.fn().mockResolvedValue('find milk'),
        ...overrides.recognizer,
      } as SpeechRecognizer,
      synthesizer: {
        speak: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        ...overrides.synthesizer,
      } as SpeechSynthesizer,
    };
  }

  test('idle -> listening -> idle (with a transcript) across a full successful start/stop', async () => {
    const session = createVoiceSession(fakeDeps());
    expect(session.status).toBe('idle');

    const startPromise = session.start();
    // status flips to 'listening' synchronously before the recognizer's
    // own promise resolves.
    expect(session.status).toBe('listening');
    await startPromise;

    const transcript = await session.stop();
    expect(transcript).toBe('find milk');
    expect(session.status).toBe('idle');
    expect(session.transcript).toBe('find milk');
  });

  test('idle -> speaking -> idle across a successful speakResponse', async () => {
    const session = createVoiceSession(fakeDeps());
    const speakPromise = session.speakResponse('hello');
    expect(session.status).toBe('speaking');
    await speakPromise;
    expect(session.status).toBe('idle');
  });

  test('a recognizer failure during start() lands in a real, non-crashing error state', async () => {
    const deps = fakeDeps({ recognizer: { startListening: jest.fn().mockRejectedValue(new Error('microphone_error')) } });
    const session = createVoiceSession(deps);

    await expect(session.start()).resolves.toBeUndefined(); // never throws
    expect(session.status).toBe('error');
    expect(session.error).toBe('microphone_error');
  });

  test('a recognizer failure during stop() also lands safely in an error state, with an empty transcript', async () => {
    const deps = fakeDeps({ recognizer: { stopListening: jest.fn().mockRejectedValue(new Error('microphone_error')) } });
    const session = createVoiceSession(deps);
    await session.start();

    const transcript = await session.stop();
    expect(transcript).toBe('');
    expect(session.status).toBe('error');
    expect(session.error).toBe('microphone_error');
  });

  test('a synthesis failure lands in an error state but speakResponse itself never throws', async () => {
    const deps = fakeDeps({ synthesizer: { speak: jest.fn().mockRejectedValue(new Error('audio unavailable')) } });
    const session = createVoiceSession(deps);

    await expect(session.speakResponse('hello')).resolves.toBeUndefined();
    expect(session.status).toBe('error');
    expect(session.error).toBe('audio unavailable');
  });
});
