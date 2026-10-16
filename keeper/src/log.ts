import type { Config } from './config';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function line(level: string, msg: string, data?: Record<string, unknown>): string {
  const extra = data
    ? ' ' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    : '';
  return `${new Date().toISOString()} ${level} ${msg}${extra}`;
}

export function createLogger(): Logger {
  return {
    info: (m, d) => console.log(line('INFO', m, d)),
    warn: (m, d) => console.warn(line('WARN', m, d)),
    error: (m, d) => console.error(line('ERROR', m, d)),
  };
}

/** Best-effort alert to a Discord/Slack-compatible webhook. Never throws. */
export async function alert(cfg: Config, msg: string): Promise<void> {
  if (!cfg.alertWebhookUrl) return;
  try {
    await fetch(cfg.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `[POD5 keeper] ${msg}`, text: `[POD5 keeper] ${msg}` }),
    });
  } catch {
    // alerts must never break a round
  }
}
