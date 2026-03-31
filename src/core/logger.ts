import pino from 'pino';

/**
 * Create a structured pino logger scoped to a specific agent or module.
 *
 * - In verbose / development mode the output is pretty-printed for readability.
 * - In normal mode the output is newline-delimited JSON for machine consumption.
 * - Every log entry includes a timestamp, level, and the agent/module name.
 *
 * @param name - Identifies the agent or module (e.g. "orchestrator", "planner").
 * @param verbose - Enable debug-level pretty-printed output.
 * @returns A configured pino Logger instance with the given name.
 */
export function createLogger(name: string, verbose?: boolean): pino.Logger {
  const level = verbose ? 'debug' : 'info';

  const baseOptions: pino.LoggerOptions = {
    name,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'config.auth.*.steps[*].value',
        'password',
        'secret',
        'token',
        'apiKey',
        'ANTHROPIC_API_KEY',
      ],
      censor: '[REDACTED]',
    },
  };

  if (verbose) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}
