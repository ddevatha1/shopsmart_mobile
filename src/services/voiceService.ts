import type { VoiceSessionState, VoiceStatus } from '../models/intent';

/**
 * Voice Foundation (Phase 4.4) — voice is only another INPUT/OUTPUT
 * modality. This file owns exactly two things: turning real audio into
 * a transcript string, and turning a response string into real audio.
 * It has NO knowledge of intents, dispatching, carts, search, or any
 * other domain concept — it never imports assistantService.ts,
 * assistantDispatcher.ts, or any domain service, and it never will.
 * That's not an implementation detail, it's the safety property this
 * whole phase exists to establish: a voice-specific bug can make speech
 * recognition or playback fail, but it structurally cannot cause a cart
 * mutation, a search, or any other app action, because this file has no
 * path to any of those.
 *
 * No speech SDK, no API keys, no provider chosen yet — see
 * `UnavailableSpeechRecognizer`/`UnavailableSpeechSynthesizer` below.
 * `setSpeechRecognitionProvider`/`setSpeechSynthesisProvider` are the
 * ONE integration point a future real provider (Apple Speech Framework,
 * Google Speech-to-Text, Whisper, ElevenLabs, OpenAI audio models, ...)
 * plugs into — swapping the provider never requires touching this file's
 * callers, `createVoiceSession`'s own logic, or anything in the assistant
 * pipeline downstream of it.
 */

// ─── Provider contracts ─────────────────────────────────────────────────

export interface SpeechRecognizer {
  startListening(): Promise<void>;
  stopListening(): Promise<string>;
}

export interface SpeechSynthesizer {
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

/** Thrown by the Unavailable* providers below — never left to crash a
 * caller; `createVoiceSession` catches this (and any other error) and
 * turns it into a safe `status: 'error'` state instead. */
export class VoiceUnavailableError extends Error {
  constructor() {
    super('voice_unavailable');
    this.name = 'VoiceUnavailableError';
  }
}

/** The default recognizer until a real provider is configured — every
 * call fails safely and predictably rather than pretending to listen. */
export class UnavailableSpeechRecognizer implements SpeechRecognizer {
  async startListening(): Promise<void> {
    throw new VoiceUnavailableError();
  }

  async stopListening(): Promise<string> {
    throw new VoiceUnavailableError();
  }
}

/** The default synthesizer until a real provider is configured.
 * `stop()` is a safe no-op even when unavailable — "stop speaking" when
 * nothing was ever speaking (or ever could) isn't an error condition. */
export class UnavailableSpeechSynthesizer implements SpeechSynthesizer {
  async speak(_text: string): Promise<void> {
    throw new VoiceUnavailableError();
  }

  async stop(): Promise<void> {
    // no-op — see this class's own doc comment.
  }
}

// ─── Swappable providers ────────────────────────────────────────────────
// The ONE seam a real provider integration touches — see this file's
// header comment. Nothing else in this app should ever construct a
// SpeechRecognizer/SpeechSynthesizer directly.

let speechRecognitionProvider: SpeechRecognizer = new UnavailableSpeechRecognizer();
let speechSynthesisProvider: SpeechSynthesizer = new UnavailableSpeechSynthesizer();

export function getSpeechRecognitionProvider(): SpeechRecognizer {
  return speechRecognitionProvider;
}

export function setSpeechRecognitionProvider(provider: SpeechRecognizer): void {
  speechRecognitionProvider = provider;
}

export function getSpeechSynthesisProvider(): SpeechSynthesizer {
  return speechSynthesisProvider;
}

export function setSpeechSynthesisProvider(provider: SpeechSynthesizer): void {
  speechSynthesisProvider = provider;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Voice session ──────────────────────────────────────────────────────

export interface VoiceSessionDependencies {
  recognizer?: SpeechRecognizer;
  synthesizer?: SpeechSynthesizer;
}

export interface VoiceSession {
  /** Begins listening. Never throws — a provider failure (including the
   * default "unavailable" provider) is caught and reflected only in
   * `status`/`error`. */
  start(): Promise<void>;
  /** Stops listening and returns the final transcript — `''` if
   * recognition failed or produced nothing, never throws. */
  stop(): Promise<string>;
  /** The most recent transcript this session has, or `''` if none yet. */
  readonly transcript: string;
  /** Speaks `text`. Never throws and never changes what the assistant
   * already decided — a synthesis failure only ever updates this
   * session's own `status`/`error`, nothing else (see Phase 4.4's own
   * "speech output failure is safe" requirement). */
  speakResponse(text: string): Promise<void>;
  readonly status: VoiceStatus;
  /** Set only when `status === 'error'`. Not part of the literal
   * `{start, stop, transcript, speakResponse, status}` shape this
   * sprint's brief specifies, but a small, well-justified addition:
   * `status === 'error'` alone doesn't say what went wrong, and every
   * other part of this app's error handling (e.g. `AssistantOutcome`)
   * always pairs a status/success flag with a real message. */
  readonly error: string | undefined;
}

/**
 * Creates one voice session — one listen-then-speak turn's worth of
 * state (see `VoiceSessionState`). `deps` defaults to whatever provider
 * is currently registered via `setSpeechRecognitionProvider`/
 * `setSpeechSynthesisProvider` (the "unavailable" ones, out of the box).
 * This function has zero knowledge of intents/dispatching — see
 * voiceAssistantService.ts for the layer that actually connects a
 * session's transcript to `runAssistant`.
 */
export function createVoiceSession(deps: VoiceSessionDependencies = {}): VoiceSession {
  const recognizer = deps.recognizer ?? getSpeechRecognitionProvider();
  const synthesizer = deps.synthesizer ?? getSpeechSynthesisProvider();

  let state: VoiceSessionState = { status: 'idle' };

  return {
    get status() {
      return state.status;
    },
    get transcript() {
      return state.transcript ?? '';
    },
    get error() {
      return state.error;
    },

    async start() {
      state = { status: 'listening' };
      try {
        await recognizer.startListening();
      } catch (err) {
        state = { status: 'error', error: errorMessage(err) };
      }
    },

    async stop() {
      state = { status: 'processing', transcript: state.transcript };
      try {
        const transcript = await recognizer.stopListening();
        state = { status: 'idle', transcript };
        return transcript;
      } catch (err) {
        state = { status: 'error', error: errorMessage(err) };
        return '';
      }
    },

    async speakResponse(text: string) {
      state = { ...state, status: 'speaking' };
      try {
        await synthesizer.speak(text);
        state = { ...state, status: 'idle' };
      } catch (err) {
        // Deliberately does NOT re-throw — see this function's own doc
        // comment and Phase 4.4's "speech output failure is safe" rule.
        state = { ...state, status: 'error', error: errorMessage(err) };
      }
    },
  };
}
