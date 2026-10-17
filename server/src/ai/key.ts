import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { AppError } from '../lib/errors';
import { resetClient } from './anthropic';

/**
 * The Anthropic API key, set from the app (top bar → AI). It is checked with Anthropic, then saved to
 * .env in the project folder so it survives restarts, and takes effect at once. The browser only
 * ever sees the last four characters.
 */
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

function envFileKey(): string | null {
  try {
    const m = fs.readFileSync(config.envFile, 'utf8').match(/^ANTHROPIC_API_KEY=(.*)$/m);
    return m?.[1].trim() || null;
  } catch { return null; }
}

export function aiKeyStatus() {
  const key = process.env.ANTHROPIC_API_KEY || null;
  return {
    enabled: config.aiEnabled,
    model: config.model,
    hint: key ? `…${key.slice(-4)}` : null,
    // A key from the shell environment (not .env) can't be changed from the app.
    source: key ? (envFileKey() === key ? 'app' : 'environment') : process.env.ANTHROPIC_AUTH_TOKEN ? 'environment' : null,
  };
}

/** Writes or removes ANTHROPIC_API_KEY in .env, keeping every other line. */
function writeEnvKey(key: string | null) {
  let lines: string[] = [];
  try { lines = fs.readFileSync(config.envFile, 'utf8').split(/\r?\n/); } catch { /* no .env yet */ }
  const at = lines.findIndex((l) => /^ANTHROPIC_API_KEY=/.test(l));
  if (key === null) { if (at >= 0) lines[at] = 'ANTHROPIC_API_KEY='; }
  else if (at >= 0) lines[at] = `ANTHROPIC_API_KEY=${key}`;
  else lines.unshift(`ANTHROPIC_API_KEY=${key}`);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  // Write a temporary file and rename it over .env, so a crash mid-write cannot leave .env half-written.
  const tmp = `${config.envFile}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, config.envFile);
}

/** Proves a key works. Listing models costs nothing. Replaced in tests. */
export const keyCheck = {
  run: async (key: string) => { await new Anthropic({ apiKey: key, authToken: null, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 }); },
};

export async function setAiKey(raw: unknown) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!KEY_RE.test(key)) throw new AppError('BAD_KEY', 400, 'That does not look like an Anthropic API key. It starts with sk-ant- and comes from console.anthropic.com → API keys.');
  try {
    await keyCheck.run(key);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AppError('BAD_KEY', 400, 'Anthropic did not accept this key. Check it was copied in full, and that it has not been disabled.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AppError('BAD_KEY', 400, 'This key is not allowed to use the API. Check the key\'s workspace and billing in the Anthropic console.');
    if (e instanceof Anthropic.APIConnectionError) throw new AppError('NO_CONNECTION', 502, 'Could not reach Anthropic to check the key. Check the internet connection and try again.');
    throw new AppError('KEY_CHECK_FAILED', 502, `Could not check the key: ${e instanceof Error ? e.message : String(e)}`);
  }
  writeEnvKey(key);
  process.env.ANTHROPIC_API_KEY = key;
  config.aiEnabled = true;
  resetClient();
  return aiKeyStatus();
}

export function removeAiKey() {
  if (aiKeyStatus().source === 'environment') {
    throw new AppError('KEY_FROM_ENVIRONMENT', 409, 'This key comes from the computer\'s environment variables, not from the app. Remove it there and restart.');
  }
  writeEnvKey(null);
  delete process.env.ANTHROPIC_API_KEY;
  config.aiEnabled = Boolean(process.env.ANTHROPIC_AUTH_TOKEN);
  resetClient();
  return aiKeyStatus();
}
