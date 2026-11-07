// server.js: hosting supervisor for the bot. Node built-ins only, so there is nothing to install.
// The panel runs this file from /home/container. It keeps worker.js running, pulls new commits
// from GitHub while it runs, and writes logs and a heartbeat into the server's folders.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const WORKER = path.join(ROOT, 'worker.js');
const UPDATE_MS = Number(process.env.UPDATE_EVERY_SEC || 300) * 1000;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_SEC || 30) * 1000;
const KEEP_LOG_DAYS = 7;

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const bootedAt = Date.now();
let child = null; // running worker process, or null
let startedAt = 0;
let startTimer = null;
let backoffMs = 1000;
let restarts = 0;
let stopping = false;
let checking = false;
let commit = '';

// Hides credentials if git ever prints a URL like https://user:token@host.
function redact(text) {
  return String(text).replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

function log(scope, text) {
  const line = `${new Date().toISOString()} [${scope}] ${redact(text)}`;
  process.stdout.write(line + '\n');
  try {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `bot-${day}.log`), line + '\n');
  } catch (err) {
    process.stdout.write(`could not write log file: ${err.message}\n`);
  }
}

function pruneLogs() {
  const cutoff = Date.now() - KEEP_LOG_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(LOG_DIR)) {
      const file = path.join(LOG_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (err) {
    log('supervisor', `log cleanup skipped: ${err.message}`);
  }
}

function heartbeat() {
  const body = {
    time: new Date().toISOString(),
    uptimeMin: Math.round((Date.now() - bootedAt) / 60000),
    commit,
    workerRunning: child !== null,
    workerRestarts: restarts,
  };
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'heartbeat.json'), JSON.stringify(body, null, 2) + '\n');
  } catch (err) {
    log('supervisor', `heartbeat failed: ${err.message}`);
  }
}

function git(args, done) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; // never wait for a password prompt
  execFile('git', args, { cwd: ROOT, env, timeout: 120000 }, (err, stdout, stderr) => {
    done(err, String(stdout || '').trim(), String(stderr || '').trim());
  });
}

function firstLine(err, msg) {
  return (msg || (err && err.message) || '').split('\n')[0];
}

function readCommit() {
  git(['rev-parse', '--short', 'HEAD'], (err, out) => {
    if (!err) commit = out;
  });
}

function checkForUpdates() {
  if (checking || !fs.existsSync(path.join(ROOT, '.git'))) return;
  checking = true;
  git(['fetch', '--quiet', 'origin'], (fetchErr, _out, fetchMsg) => {
    if (fetchErr) {
      checking = false;
      return log('git', `fetch failed: ${firstLine(fetchErr, fetchMsg)}`);
    }
    git(['rev-list', '--count', 'HEAD..@{u}'], (countErr, count) => {
      if (countErr || count === '0') {
        checking = false;
        return;
      }
      log('git', `${count} new commit(s) on GitHub, pulling`);
      git(['pull', '--ff-only', '--quiet'], (pullErr, _out2, pullMsg) => {
        checking = false;
        if (pullErr) return log('git', `pull failed: ${firstLine(pullErr, pullMsg)}`);
        readCommit();
        restartWorker('new code pulled');
      });
    });
  });
}

function scheduleStart(delayMs) {
  clearTimeout(startTimer);
  startTimer = setTimeout(startWorker, delayMs);
}

function startWorker() {
  startTimer = null;
  if (child || stopping) return;
  if (!fs.existsSync(WORKER)) {
    log('supervisor', 'worker.js not found, checking again in 60 s');
    return scheduleStart(60000);
  }
  startedAt = Date.now();
  child = spawn(process.execPath, [WORKER], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  log('supervisor', `worker started (pid ${child.pid})`);
  const relay = (scope) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log(scope, line);
    }
  };
  child.stdout.on('data', relay('worker'));
  child.stderr.on('data', relay('worker!'));
  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    log('supervisor', `worker exited (code ${code}, signal ${signal})`);
    if (stopping) return process.exit(0);
    restarts += 1;
    const delay = backoffMs;
    backoffMs = ranMs > 60000 ? 1000 : Math.min(backoffMs * 2, 60000);
    log('supervisor', `restarting worker in ${delay / 1000} s`);
    scheduleStart(delay);
  });
}

function restartWorker(reason) {
  log('supervisor', `restarting worker: ${reason}`);
  backoffMs = 1000;
  if (!child) return scheduleStart(0);
  const old = child;
  old.kill('SIGTERM');
  setTimeout(() => {
    if (child === old) old.kill('SIGKILL');
  }, 10000);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('supervisor', `${signal} received, stopping the worker`);
  heartbeat();
  if (!child) return process.exit(0);
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('supervisor!', `uncaught error: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (err) => {
  log('supervisor!', `unhandled rejection: ${err && err.stack ? err.stack : err}`);
});

log('supervisor', `started in ${ROOT}, update check every ${UPDATE_MS / 1000} s`);
if (!fs.existsSync(path.join(ROOT, '.git'))) log('git', 'no .git folder, so auto-update is off');
pruneLogs();
readCommit();
heartbeat();
startWorker();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(pruneLogs, 6 * 60 * 60 * 1000);
setInterval(checkForUpdates, UPDATE_MS);
