import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every value has a safe default except the encryption key, which is required
 * in production. Nothing here reads a secret from a file path or a URL; secrets
 * come from the environment only.
 */

const booleanish = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AURALIS_HOST: z.string().default('127.0.0.1'),
  AURALIS_PORT: z.coerce.number().int().min(1).max(65535).default(5175),
  AURALIS_DATABASE_PATH: z.string().default('./data/auralis.db'),
  AURALIS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Off by default. Turning it on logs the text of user searches. */
  AURALIS_LOG_QUERY_TEXT: booleanish.default('false'),
  /**
   * 32-byte key, base64 encoded, used to encrypt connector credentials.
   * Required in production; a development key is derived when absent elsewhere.
   */
  AURALIS_SECRET_KEY: z.string().optional(),
  AURALIS_SESSION_SECRET: z.string().optional(),
  /** Comma separated origins permitted to call the API from a browser. */
  AURALIS_CORS_ORIGINS: z.string().default('http://localhost:5174,http://127.0.0.1:5174'),
  /** Serves the built web client from the API process when true. */
  AURALIS_SERVE_WEB: booleanish.default('false'),
  AURALIS_WEB_DIST: z.string().default('../web/dist'),
  /**
   * Allows the egress layer to reach private addresses. This exists so the
   * bundled fixture origin can be searched in development and tests. It is
   * rejected when NODE_ENV is production.
   */
  AURALIS_ALLOW_PRIVATE_EGRESS: booleanish.default('false'),
  /** Enables plain http targets. Needed for the local fixture origin. */
  AURALIS_ALLOW_INSECURE_HTTP: booleanish.default('false'),
  AURALIS_FIXTURE_ORIGIN_PORT: z.coerce.number().int().min(1).max(65535).default(5176),
  /** Directory the fixture origin serves. Generated on first run. */
  AURALIS_FIXTURE_DIR: z.string().default('./data/fixtures'),
  /** Redis-compatible connection string. When absent, an in-process cache is used. */
  AURALIS_REDIS_URL: z.string().optional(),
  AURALIS_RATE_LIMIT_SEARCHES_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
  AURALIS_RATE_LIMIT_DOWNLOADS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(40),
  /** Days before search history is deleted. */
  AURALIS_SEARCH_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly logQueryText: boolean;
  readonly secretKey: Buffer;
  readonly sessionSecret: string;
  readonly corsOrigins: readonly string[];
  readonly serveWeb: boolean;
  readonly webDist: string;
  readonly allowPrivateEgress: boolean;
  readonly allowInsecureHttp: boolean;
  readonly fixtureOriginPort: number;
  readonly fixtureDir: string;
  readonly redisUrl: string | null;
  readonly searchesPerMinute: number;
  readonly downloadsPerMinute: number;
  readonly searchRetentionDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEV_KEY_MATERIAL = 'auralis-development-key-not-for-production';

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && env.AURALIS_ALLOW_PRIVATE_EGRESS) {
    throw new ConfigError(
      'AURALIS_ALLOW_PRIVATE_EGRESS cannot be enabled when NODE_ENV is production.',
    );
  }

  let secretKey: Buffer;
  if (env.AURALIS_SECRET_KEY) {
    secretKey = Buffer.from(env.AURALIS_SECRET_KEY, 'base64');
    if (secretKey.length !== 32) {
      throw new ConfigError('AURALIS_SECRET_KEY must be 32 bytes encoded as base64.');
    }
  } else if (isProduction) {
    throw new ConfigError(
      'AURALIS_SECRET_KEY is required in production. Generate one with: openssl rand -base64 32',
    );
  } else {
    // A fixed development key keeps local databases readable across restarts.
    secretKey = Buffer.alloc(32);
    Buffer.from(DEV_KEY_MATERIAL).copy(secretKey, 0, 0, Math.min(32, DEV_KEY_MATERIAL.length));
  }

  const sessionSecret =
    env.AURALIS_SESSION_SECRET ?? (isProduction ? '' : `dev-${DEV_KEY_MATERIAL}`);
  if (sessionSecret.length < 32) {
    if (isProduction) {
      throw new ConfigError('AURALIS_SESSION_SECRET must be at least 32 characters in production.');
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    host: env.AURALIS_HOST,
    port: env.AURALIS_PORT,
    databasePath: env.AURALIS_DATABASE_PATH,
    logLevel: env.AURALIS_LOG_LEVEL,
    logQueryText: env.AURALIS_LOG_QUERY_TEXT,
    secretKey,
    sessionSecret,
    corsOrigins: env.AURALIS_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    serveWeb: env.AURALIS_SERVE_WEB,
    webDist: env.AURALIS_WEB_DIST,
    allowPrivateEgress: env.AURALIS_ALLOW_PRIVATE_EGRESS,
    allowInsecureHttp: env.AURALIS_ALLOW_INSECURE_HTTP,
    fixtureOriginPort: env.AURALIS_FIXTURE_ORIGIN_PORT,
    fixtureDir: env.AURALIS_FIXTURE_DIR,
    redisUrl: env.AURALIS_REDIS_URL ?? null,
    searchesPerMinute: env.AURALIS_RATE_LIMIT_SEARCHES_PER_MINUTE,
    downloadsPerMinute: env.AURALIS_RATE_LIMIT_DOWNLOADS_PER_MINUTE,
    searchRetentionDays: env.AURALIS_SEARCH_RETENTION_DAYS,
  };
}
