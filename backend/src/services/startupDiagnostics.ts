/**
 * One-shot, boot-time sanity check — runs before warm-up even starts, so a
 * misconfigured production deploy (missing Chromium, missing/mistyped
 * Kroger credentials) shows up as a clear, immediate log line instead of
 * only surfacing later as a confusing per-store search error that requires
 * reproducing a real search to even notice.
 *
 * Deliberately never logs a credential value, even partially (not even a
 * prefix/suffix) — only presence, length, and whether it had
 * leading/trailing whitespace (the single most common real-world cause of
 * a "credentials exist but auth still fails" bug: a stray newline or space
 * from copy-pasting a secret into a hosting dashboard's env var field,
 * which silently corrupts a Base64 Basic-Auth header).
 */
import * as fs from 'fs';
import { chromium } from 'playwright';

function describeEnvCredential(name: string): string {
  const raw = process.env[name];
  if (raw === undefined) return `${name}: MISSING`;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return `${name}: EMPTY`;
  const whitespaceNote =
    trimmed !== raw ? ' (had leading/trailing whitespace — trimmed automatically before use)' : '';
  return `${name}: present, length=${trimmed.length}${whitespaceNote}`;
}

function describeChromium(): string {
  let executablePath: string;
  try {
    executablePath = chromium.executablePath();
  } catch (err) {
    return `Chromium: could not resolve an executable path — ${err instanceof Error ? err.message : String(err)}`;
  }
  const exists = fs.existsSync(executablePath);
  return exists
    ? `Chromium: OK — found at ${executablePath}`
    : `Chromium: MISSING — expected at ${executablePath}. Trader Joe's session bootstrap and the ` +
      'Sprouts product-image fallback will fail until this is installed. Check the deploy\'s build ' +
      'logs for the "postinstall" step\'s Playwright download output (backend/package.json).';
}

export function logStartupDiagnostics(): void {
  console.log('[Startup] ── environment / integration diagnostics ──');
  console.log(`[Startup] ${describeEnvCredential('KROGER_CLIENT_ID')}`);
  console.log(`[Startup] ${describeEnvCredential('KROGER_CLIENT_SECRET')}`);
  console.log(`[Startup] ${describeChromium()}`);
  console.log('[Startup] ───────────────────────────────────────────');
}
