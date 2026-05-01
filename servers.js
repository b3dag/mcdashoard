/* =========================================================
   servers.js — registry + actions for Minecraft servers.
   ========================================================= */

import { readFile, writeFile, readdir, stat, mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { Rcon } from 'rcon-client';

import { stmts } from './db.js';

const cfg = JSON.parse(
  await readFile(new URL('./servers.json', import.meta.url), 'utf8')
);

const REGISTRY = new Map();
for (const s of cfg.servers) {
  if (!/^[a-z0-9-]+$/.test(s.name)) {
    throw new Error(`invalid server name: ${s.name}`);
  }
  REGISTRY.set(s.name, s);
}

export function listServers() {
  return [...REGISTRY.values()].map(s => ({
    name:         s.name,
    display_name: s.display_name,
  }));
}

export function getServer(name) {
  return REGISTRY.get(name);
}

function run(cmd, args) {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.on('close', code => resolveP({ code, stdout, stderr }));
    p.stdin.end();
  });
}

async function systemctl(action, unit) {
  return run('systemctl', ['--user', action, unit]);
}

export async function startServer(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');
  return systemctl('start', s.systemd_unit);
}

export async function stopServer(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');
  return systemctl('stop', s.systemd_unit);
}

export async function restartServer(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');
  return systemctl('restart', s.systemd_unit);
}

export async function getServerStatus(name) {
  const s = getServer(name);
  if (!s) return { running: false, error: 'unknown server' };

  const r = await systemctl('is-active', s.systemd_unit);
  const running = r.stdout.trim() === 'active';
  return { running };
}

/* ---------- logs ---------- */

export async function getServerLogs(name, lines = 200) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const r = await run('journalctl', [
    '--user', '-u', s.systemd_unit,
    '--no-pager', '--output=short-iso',
    '-n', String(lines),
  ]);
  if (r.code !== 0) throw new Error(r.stderr || 'journalctl failed');
  return r.stdout;
}

export function streamServerLogs(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const p = spawn('journalctl', [
    '--user', '-u', s.systemd_unit,
    '--no-pager', '--output=short-iso',
  ]);
  p.stdin.end();
  p.stderr.on('data', () => {});
  return p.stdout;
}

/* ---------- RCON ---------- */

export async function rconCommand(name, command) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const password = process.env[s.rcon.password_env];
  if (!password) throw new Error(`RCON password not set (env: ${s.rcon.password_env})`);

  const client = await Rcon.connect({
    host:     s.rcon.host,
    port:     s.rcon.port,
    password,
    timeout:  5000,
  }).catch(e => { throw new Error(`rcon connect failed: ${e.message}`); });

  try {
    return await client.send(command);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function getOnlinePlayerCount(name) {
  try {
    const result = await rconCommand(name, 'list');
    const m = result.match(/There are\s+(\d+)\s+of/i);
    if (!m) return null;
    return parseInt(m[1], 10);
  } catch {
    return null;
  }
}

/* ---------- per-server settings ---------- */

export function getAutoStopMinutes(name) {
  const row = stmts.getServerSetting.get(name, 'auto_stop_minutes');
  return row ? parseInt(row.value, 10) : 0;
}

export function setAutoStopMinutes(name, minutes) {
  if (!getServer(name)) throw new Error('unknown server');
  const value = parseInt(minutes, 10);
  if (isNaN(value) || value < 0) throw new Error('invalid value');
  stmts.setServerSetting.run(name, 'auto_stop_minutes', String(value));
}

/* ---------- sandboxed file access ---------- */

function sandboxedPath(server, userPath) {
  const root = resolve(server.folder);

  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('invalid path');
  if (isAbsolute(userPath))                                 throw new Error('absolute paths not allowed');
  if (userPath.includes('\0'))                              throw new Error('null byte in path');

  const full = resolve(root, userPath);
  const rel  = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('path escapes server folder');
  }
  return full;
}

/* file/folder name validation — for create / rename. Avoid path
   separators in the name itself. */
function validateEntryName(n) {
  if (typeof n !== 'string' || n.length === 0)         throw new Error('name required');
  if (n.length > 255)                                  throw new Error('name too long');
  if (n.includes('/') || n.includes('\\'))             throw new Error('name cannot contain slashes');
  if (n === '.' || n === '..')                         throw new Error('invalid name');
  if (n.includes('\0'))                                throw new Error('null byte in name');
}

export async function listFiles(name, subPath = '.') {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const dir = sandboxedPath(s, subPath);
  const items = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const it of items) {
    const full = join(dir, it.name);
    const st = await stat(full).catch(() => null);
    out.push({
      name: it.name,
      type: it.isDirectory() ? 'dir' : it.isFile() ? 'file' : 'other',
      size: st?.size ?? 0,
      mtime: st?.mtimeMs ?? 0,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

const MAX_READ_BYTES  = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export async function readServerFile(name, subPath) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const full = sandboxedPath(s, subPath);
  const st   = await stat(full);
  if (!st.isFile())             throw new Error('not a regular file');
  if (st.size > MAX_READ_BYTES) throw new Error('file too large to view');
  return readFile(full, 'utf8');
}

export async function writeServerFile(name, subPath, content) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  if (typeof content !== 'string')                  throw new Error('content must be a string');
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error('content too large');

  const full = sandboxedPath(s, subPath);
  await writeFile(full, content, 'utf8');
}

/* ---------- file operations: download, upload, mkdir, rename, delete ---------- */

/* Returns { stream, size, name } for downloading a file. Caller pipes
   the stream to the response. */
export async function downloadServerFile(name, subPath) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const full = sandboxedPath(s, subPath);
  const st   = await stat(full);
  if (!st.isFile()) throw new Error('not a regular file');

  return {
    stream: createReadStream(full),
    size:   st.size,
    name:   subPath.split('/').pop(),
  };
}

/* Save an upload stream to the given folder. The destination is
   <folder>/<filename>. Filename comes from the multipart upload and
   gets validated. Returns total bytes written.
   Errors with "file too large" if maxBytes is exceeded. */
export async function uploadServerFile(name, folderPath, filename, dataStream, maxBytes) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  validateEntryName(filename);

  const folderFull = sandboxedPath(s, folderPath || '.');
  const folderStat = await stat(folderFull);
  if (!folderStat.isDirectory()) throw new Error('target is not a folder');

  const dest = join(folderFull, filename);

  /* sanity check: dest must still be inside the server folder
     (validateEntryName already prevents the worst cases) */
  const destRel = relative(resolve(s.folder), dest);
  if (destRel.startsWith('..') || isAbsolute(destRel)) {
    throw new Error('destination escapes server folder');
  }

  return new Promise((resolveP, rejectP) => {
    let written = 0;
    const out = createWriteStream(dest);
    let errored = false;

    dataStream.on('data', (chunk) => {
      written += chunk.length;
      if (written > maxBytes) {
        errored = true;
        out.destroy();
        dataStream.destroy?.();
        rm(dest, { force: true }).catch(() => {});
        rejectP(new Error('file too large'));
      }
    });
    dataStream.on('error', (e) => { errored = true; rejectP(e); });
    out.on('error', (e) => { errored = true; rejectP(e); });
    out.on('finish', () => { if (!errored) resolveP({ bytes: written }); });

    dataStream.pipe(out);
  });
}

export async function createFolder(name, parentPath, folderName) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  validateEntryName(folderName);
  const parent = sandboxedPath(s, parentPath || '.');
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) throw new Error('parent is not a folder');

  const target = join(parent, folderName);
  /* re-sandbox the target to be safe */
  const rel = relative(resolve(s.folder), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('escapes server folder');

  await mkdir(target, { recursive: false });
}

export async function renameServerEntry(name, fromPath, toName) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  validateEntryName(toName);

  const fromFull = sandboxedPath(s, fromPath);
  const parent   = dirname(fromFull);
  const toFull   = join(parent, toName);

  /* keep target inside server folder */
  const rel = relative(resolve(s.folder), toFull);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('target escapes server folder');

  await rename(fromFull, toFull);
}

export async function deleteServerEntry(name, subPath) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  /* never delete the server root itself */
  if (subPath === '.' || subPath === '' || subPath === '/') {
    throw new Error('cannot delete server root');
  }

  const full = sandboxedPath(s, subPath);
  /* rm with recursive + force handles both files and folders, missing or not */
  await rm(full, { recursive: true, force: true });
}
