#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Development runner.
 *
 * Builds the shared packages once, then runs the API (with the bundled fixture
 * origin) and the Vite dev server together, forwarding both log streams and
 * shutting everything down on the first exit.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const environment = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  AURALIS_ALLOW_PRIVATE_EGRESS: process.env.AURALIS_ALLOW_PRIVATE_EGRESS ?? 'true',
  AURALIS_ALLOW_INSECURE_HTTP: process.env.AURALIS_ALLOW_INSECURE_HTTP ?? 'true',
};

const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code ?? 0}\n`);
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const build = spawn('npx', ['tsc', '-b', 'packages/core', 'packages/server'], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});

build.on('exit', (code) => {
  if (code !== 0) {
    process.stderr.write('Build failed; not starting the development servers.\n');
    process.exit(code ?? 1);
  }
  run('api', 'node', ['packages/server/dist/main.js']);
  run('web', 'npx', ['vite', '--config', 'packages/web/vite.config.ts', 'packages/web']);
  process.stdout.write('\nAuralis is starting. Open http://localhost:5174\n\n');
});
