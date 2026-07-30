import type { AssistantOutcome, AssistantSessionContext, AssistantVoiceResponse } from '../models/intent';
import { runAssistant } from './assistantService';
import { formatAssistantResponse } from './assistantResponseService';
import { createVoiceSession, type VoiceSession } from './voiceService';

/**
 * Connects voice to the EXISTING, UNCHANGED assistant pipeline:
 *
 *   audio input -> speech recognition -> runAssistant(transcript) ->
 *   formatAssistantResponse() -> speech synthesis
 *
 * This file never calls a cart mutation, search, planner, or store API
 * directly — it only ever calls `runAssistant`, exactly the same
 * function a typed-text caller would call. `runAssistant` is what runs
 * `evaluateClarificationPolicy` and `dispatchIntent` (which in turn runs
 * intentPolicy.ts's own gates) — none of that changes for voice input;
 * a transcript is just another string handed to the exact same pipeline.
 * See voiceService.ts's own header comment for the complementary half of
 * this guarantee: it has no path TO this pipeline in the first place.
 */

export interface VoiceAssistantResult {
  /** The real transcript recognition produced — `''` if recognition
   * failed or produced nothing. */
  transcript: string;
  outcome: AssistantOutcome;
  response: AssistantVoiceResponse;
}

export interface VoiceAssistantDependencies {
  session?: VoiceSession;
  runAssistant?: typeof runAssistant;
}

function recognitionFailureResult(reason: string): VoiceAssistantResult {
  return {
    transcript: '',
    outcome: {
      success: false,
      intent: { type: 'unknown', confidence: 0, parameters: {} },
      // 'service_failure' is the closest existing AssistantError fit —
      // see models/intent.ts's own taxonomy. Recognition failing means
      // the assistant pipeline never even ran; 'network_error' would be
      // misleading here, since it specifically means the BACKEND intent
      // call failed, which never happened in this path at all.
      errorType: 'service_failure',
      error: reason,
    },
    response: { text: 'Sorry, I could not hear you clearly.', shouldSpeak: true },
  };
}

/**
 * Runs exactly one voice turn: listen, resolve+dispatch through the
 * unchanged assistant pipeline, then speak the real result. Never
 * throws — a recognition failure (including the default "unavailable"
 * provider) or a synthesis failure both resolve to a safe result rather
 * than a crash (see voiceService.ts's `createVoiceSession`, which
 * already guarantees this at the session level).
 */
export async function runVoiceAssistantTurn(
  context: AssistantSessionContext = {},
  deps: VoiceAssistantDependencies = {},
): Promise<VoiceAssistantResult> {
  const session = deps.session ?? createVoiceSession();
  const run = deps.runAssistant ?? runAssistant;

  await session.start();
  const transcript = await session.stop();

  if (!transcript) {
    return recognitionFailureResult(session.error ?? 'No speech was recognized.');
  }

  // The ONLY call this file ever makes into the assistant pipeline — the
  // exact same function a typed-text entry point calls, with the exact
  // same safety gates (clarification policy, then dispatchIntent's own
  // evaluateIntent/validateSessionContext) applying unconditionally.
  const outcome = await run(transcript, context);
  const response = formatAssistantResponse(outcome);

  // Never throws (see voiceService.ts) — a synthesis failure only ever
  // changes the session's own status, never `outcome`/`response` here.
  await session.speakResponse(response.text);

  return { transcript, outcome, response };
}
