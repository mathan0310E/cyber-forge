import pino from 'pino';
import type { Config } from '../config/env.js';

let root: pino.Logger | undefined;

export function initLogger(config: Config): pino.Logger {
  root = pino({
    level: config.env.NODE_ENV === 'test' ? 'silent' : 'info',
    base: { service: 'wolf-forge-api', env: config.env.NODE_ENV },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.password',
        '*.privateKey',
        '*.OPENROUTER_API_KEY',
        '*.GITHUB_CLIENT_SECRET',
        '*.INTEGRATION_ENCRYPTION_KEY',
        '*.DEPLOYMENT_API_TOKEN',
      ],
      censor: '[redacted]',
    },
  });
  return root;
}

export function logger(): pino.Logger {
  if (!root) {
    root = pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' });
  }
  return root;
}

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger().child(bindings);
}
