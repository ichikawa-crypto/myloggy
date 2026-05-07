import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const devPidPath = path.join(os.tmpdir(), 'myloggy-dev.pid');

const cwd = process.cwd();
const preloadPath = path.join(cwd, 'dist-electron', 'electron', 'preload.js');

function log(scope, message) {
  process.stdout.write(`[${scope}] ${message}\n`);
}

/** @returns {boolean} */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

function assertNoOtherDevProcess() {
  if (!fs.existsSync(devPidPath)) {
    return;
  }
  const raw = fs.readFileSync(devPidPath, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      fs.unlinkSync(devPidPath);
    } catch {
      // ignore
    }
    return;
  }
  if (isPidAlive(pid)) {
    process.stderr.write(
      `[dev] another dev process is already running (pid=${pid}). abort.\n`,
    );
    process.exit(1);
  }
  try {
    fs.unlinkSync(devPidPath);
  } catch {
    // ignore; will overwrite when claiming PID
  }
}

function removeDevPidFile() {
  try {
    fs.unlinkSync(devPidPath);
  } catch {
    // ignore missing file / races
  }
}

function writeDevPidFile() {
  fs.writeFileSync(devPidPath, `${process.pid}\n`, 'utf8');
}

function pipeOutput(scope, child) {
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(
      chunk
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => `[${scope}] ${line}`)
        .join('\n') + '\n',
    );
  });

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(
      chunk
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => `[${scope}] ${line}`)
        .join('\n') + '\n',
    );
  });
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found from ${startPort}`);
}

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const children = new Set();

function devProcessEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function spawnCommand(scope, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: devProcessEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.add(child);
  pipeOutput(scope, child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (scope === 'dev:electron') {
      if (signal) {
        log(scope, `exited with signal ${signal}`);
      } else {
        log(scope, `exited with code ${code}`);
      }
      shutdown(0);
      return;
    }
    if (signal) {
      log(scope, `exited with signal ${signal}`);
      return;
    }
    log(scope, `exited with code ${code}`);
    if (code && code !== 0) {
      shutdown(code);
    }
  });
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  removeDevPidFile();
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  assertNoOtherDevProcess();

  const port = await findFreePort(5173);
  writeDevPidFile();

  const devServerUrl = `http://127.0.0.1:${port}`;
  log('dev', `using renderer port ${port}`);

  spawnCommand('dev:main', 'npm', ['run', 'dev:main']);
  spawnCommand('dev:renderer', 'npm', ['run', 'dev:renderer', '--', '--port', String(port), '--strictPort']);

  await Promise.all([waitForFile(preloadPath), waitForPort(port)]);

  spawnCommand('dev:electron', 'npm', ['run', 'dev:electron'], {
    VITE_DEV_SERVER_URL: devServerUrl,
  });
}

main().catch((error) => {
  process.stderr.write(`[dev] ${error instanceof Error ? error.message : String(error)}\n`);
  shutdown(1);
});
