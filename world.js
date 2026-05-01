/* =========================================================
   world.js — world folder zip + game log archive helpers.
   ---------------------------------------------------------
     - listWorldFolders(name)         -> string[]  detected worlds
     - downloadWorldZip(name, folder) -> Readable  zip of that folder
     - uploadAndReplaceWorld(name, folder, zipStream)
         -> { entries, bytes }   wipes folder + extracts zip into it
     - listGameLogs(name)             -> {name, size, mtime, gzipped}[]
     - readGameLog(name, file)        -> string  decompresses .gz on the fly
     - downloadAllGameLogs(name)      -> Readable  zip of the logs/ folder
   ========================================================= */

import { stat, readdir, rm, mkdir, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep, dirname } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';

import archiver from 'archiver';
import unzipper from 'unzipper';

import { getServer } from './servers.js';

function sandboxedPath(server, userPath) {
  const root = resolve(server.folder);

  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('invalid path');
  if (isAbsolute(userPath))                                  throw new Error('absolute paths not allowed');
  if (userPath.includes('\0'))                               throw new Error('null byte in path');

  const full = resolve(root, userPath);
  const rel  = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('path escapes server folder');
  }
  return full;
}

/* ---------- worlds ---------- */

export async function listWorldFolders(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const root = resolve(s.folder);
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const levelDat = join(root, e.name, 'level.dat');
    try {
      const st = await stat(levelDat);
      if (st.isFile()) result.push(e.name);
    } catch { /* not a world */ }
  }

  if (result.length === 0) {
    for (const e of entries) {
      if (e.isDirectory() && /^world/i.test(e.name)) result.push(e.name);
    }
  }

  result.sort();
  return result;
}

export function downloadWorldZip(name, folder) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const folderFull = sandboxedPath(s, folder);

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  archive.directory(folderFull, folder);
  archive.finalize();
  return archive;
}

export async function uploadAndReplaceWorld(name, folder, zipStream) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const targetRoot = sandboxedPath(s, folder);

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  let entries = 0;
  let bytes = 0;
  let prefixToStrip = null;

  const parseStream = zipStream.pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of parseStream) {
    try {
      let entryPath = entry.path;

      if (prefixToStrip === null) {
        const firstSegment = entryPath.split(/[/\\]/)[0];
        prefixToStrip = (firstSegment === folder) ? folder + '/' : '';
      }
      if (prefixToStrip && entryPath.startsWith(prefixToStrip)) {
        entryPath = entryPath.slice(prefixToStrip.length);
      }

      if (!entryPath || entryPath === '/') {
        entry.autodrain();
        continue;
      }

      if (entryPath.includes('\0'))  throw new Error('zip entry has null byte: ' + entry.path);
      if (isAbsolute(entryPath))     throw new Error('zip entry is absolute: ' + entry.path);

      const fullDest = resolve(targetRoot, entryPath);
      const rel = relative(targetRoot, fullDest);
      if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
        throw new Error('zip entry escapes target: ' + entry.path);
      }

      if (entry.type === 'Directory') {
        await mkdir(fullDest, { recursive: true });
        entry.autodrain();
        continue;
      }

      await mkdir(dirname(fullDest), { recursive: true });

      let entryBytes = 0;
      entry.on('data', (chunk) => { entryBytes += chunk.length; });
      await pipeline(entry, createWriteStream(fullDest));
      bytes += entryBytes;
      entries++;
    } catch (err) {
      entry.autodrain?.();
      throw err;
    }
  }

  return { entries, bytes };
}

/* ---------- game logs ---------- */

/* List all files in <serverFolder>/logs that look like game logs.
   Includes latest.log and the rotated <date>-N.log.gz files.
   Returned newest-first based on filename ordering: latest.log first,
   then dated files reverse-sorted (newest dates first). */
export async function listGameLogs(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const logsDir = sandboxedPath(s, 'logs');
  let entries = [];
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch (e) {
    /* logs dir doesn't exist yet (server never started) */
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const isLatest = e.name === 'latest.log';
    const isDated  = /^\d{4}-\d{2}-\d{2}-\d+\.log(\.gz)?$/.test(e.name);
    if (!isLatest && !isDated) continue;

    const full = join(logsDir, e.name);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    out.push({
      name:    e.name,
      size:    st.size,
      mtime:   st.mtimeMs,
      gzipped: e.name.endsWith('.gz'),
    });
  }

  /* sort: latest.log first, then dated files newest-first by name */
  out.sort((a, b) => {
    if (a.name === 'latest.log') return -1;
    if (b.name === 'latest.log') return 1;
    return b.name.localeCompare(a.name);
  });
  return out;
}

/* Reads one log file. Decompresses if it's a .gz.
   Filename is validated: must match the same patterns as listGameLogs. */
export async function readGameLog(name, file) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const isLatest = file === 'latest.log';
  const isDated  = /^\d{4}-\d{2}-\d{2}-\d+\.log(\.gz)?$/.test(file);
  if (!isLatest && !isDated) throw new Error('invalid log filename');

  const full = sandboxedPath(s, join('logs', file));
  const buf  = await readFile(full);

  if (file.endsWith('.gz')) {
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

/* Returns a zip stream containing every file in the logs/ directory.
   Old .gz files are included as-is (not decompressed) so the archive
   stays small. Compression is set to 0 since the contents are already
   compressed. */
export function downloadAllGameLogs(name) {
  const s = getServer(name);
  if (!s) throw new Error('unknown server');

  const logsDir = sandboxedPath(s, 'logs');

  const archive = archiver('zip', { zlib: { level: 0 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  archive.directory(logsDir, 'logs');
  archive.finalize();
  return archive;
}
