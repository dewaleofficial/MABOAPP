#!/usr/bin/env node
'use strict';

/**
 * Kills whatever is listening on PORT (default 3000) by port lookup, not by
 * process tree. `pnpm run start` wraps `node dist/main.js` in an
 * intermediate shell on Windows, and killing that wrapper does not
 * propagate to the node child — confirmed directly during the auth/
 * transition attack suite verification.
 */

const { execSync } = require('node:child_process');

const port = process.env.PORT || '3000';

function findWindowsPids(port) {
  let output;
  try {
    output = execSync('netstat -ano', { encoding: 'utf8' });
  } catch (err) {
    console.error('Failed to run netstat:', err.message);
    return [];
  }
  const pids = new Set();
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // cols: [Proto, LocalAddress, ForeignAddress, State, PID]
    if (cols.length < 5) continue;
    const [, localAddress, , state, pid] = cols;
    if (state !== 'LISTENING') continue;
    if (!localAddress.endsWith(`:${port}`)) continue;
    pids.add(pid);
  }
  return [...pids];
}

function findPosixPids(port) {
  try {
    const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
    return output.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const pids = process.platform === 'win32' ? findWindowsPids(port) : findPosixPids(port);

if (pids.length === 0) {
  console.log(`No process found listening on port ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`);
    } else {
      execSync(`kill -9 ${pid}`);
    }
    console.log(`Killed PID ${pid} (port ${port}).`);
  } catch (err) {
    console.error(`Failed to kill PID ${pid}:`, err.message);
  }
}
