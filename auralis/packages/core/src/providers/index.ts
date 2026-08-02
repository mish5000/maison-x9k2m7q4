import { CustomJsonApiProvider, CUSTOM_API_SECRET_CONFIG_KEYS } from './custom-json-api.js';
import { FtpDirectoryProvider, FTP_SECRET_CONFIG_KEYS } from './ftp-directory.js';
import { HttpDirectoryProvider } from './http-directory.js';
import { InternetArchiveProvider } from './internet-archive.js';
import { LibriVoxProvider } from './librivox.js';
import { LocalFilesProvider } from './local-files.js';
import { ProviderRegistry } from './registry.js';
import { RssFeedProvider } from './rss-feed.js';
import { S3CompatibleProvider, S3_SECRET_CONFIG_KEYS } from './s3-compatible.js';
import { WebDavProvider, WEBDAV_SECRET_CONFIG_KEYS } from './webdav.js';
import { WikimediaCommonsProvider } from './wikimedia-commons.js';
import type { UrlSafetyPolicy } from '../net/url-safety.js';

export * from './custom-json-api.js';
export * from './ftp-directory.js';
export * from './helpers.js';
export * from './http-directory.js';
export * from './internet-archive.js';
export * from './librivox.js';
export * from './local-files.js';
export * from './rss-feed.js';
export * from './s3-compatible.js';
export * from './webdav.js';
export * from './wikimedia-commons.js';

export interface RegistryOptions {
  /** Passed to adapters that open their own sockets, such as FTP. */
  readonly urlPolicy?: UrlSafetyPolicy;
}

/**
 * Builds the default registry.
 *
 * Every adapter listed here is a real integration against a documented,
 * publicly described protocol or API. Adapters that need credentials or
 * administrator configuration are registered but stay in `not_configured`
 * until their required settings exist — they are never silently skipped and
 * never pretend to work.
 */
export function createDefaultRegistry(options: RegistryOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register({
    provider: new InternetArchiveProvider(),
    setupDocPath: 'docs/providers/internet-archive.md',
    secretConfigKeys: [],
    enabledByDefault: true,
  });

  registry.register({
    provider: new WikimediaCommonsProvider(),
    setupDocPath: 'docs/providers/wikimedia-commons.md',
    secretConfigKeys: [],
    enabledByDefault: true,
  });

  registry.register({
    provider: new LibriVoxProvider(),
    setupDocPath: 'docs/providers/librivox.md',
    secretConfigKeys: [],
    enabledByDefault: true,
  });

  registry.register({
    provider: new RssFeedProvider(),
    setupDocPath: 'docs/providers/rss-feed.md',
    secretConfigKeys: [],
    enabledByDefault: false,
  });

  registry.register({
    provider: new HttpDirectoryProvider(),
    setupDocPath: 'docs/providers/http-directory.md',
    secretConfigKeys: [],
    enabledByDefault: false,
  });

  registry.register({
    provider: new FtpDirectoryProvider(options.urlPolicy ? { policy: options.urlPolicy } : {}),
    setupDocPath: 'docs/providers/ftp-directory.md',
    secretConfigKeys: [...FTP_SECRET_CONFIG_KEYS],
    enabledByDefault: false,
  });

  registry.register({
    provider: new LocalFilesProvider(),
    setupDocPath: 'docs/providers/local-files.md',
    secretConfigKeys: [],
    enabledByDefault: false,
  });

  registry.register({
    provider: new S3CompatibleProvider(),
    setupDocPath: 'docs/providers/s3-compatible.md',
    secretConfigKeys: [...S3_SECRET_CONFIG_KEYS],
    enabledByDefault: false,
  });

  registry.register({
    provider: new WebDavProvider(),
    setupDocPath: 'docs/providers/webdav.md',
    secretConfigKeys: [...WEBDAV_SECRET_CONFIG_KEYS],
    enabledByDefault: false,
  });

  registry.register({
    provider: new CustomJsonApiProvider(),
    setupDocPath: 'docs/providers/custom-json-api.md',
    secretConfigKeys: [...CUSTOM_API_SECRET_CONFIG_KEYS],
    enabledByDefault: false,
  });

  return registry;
}

/** Provider ids that require no configuration and run out of the box. */
export const ZERO_CONFIG_PROVIDER_IDS: readonly string[] = Object.freeze([
  'internet-archive',
  'wikimedia-commons',
  'librivox',
]);
