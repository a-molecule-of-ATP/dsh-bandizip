/**
 * Host half of the Bandizip bundle: registers nine semantic model tools that drive the
 * local Bandizip console executable (bz.exe) — list / extract / create / check / diff /
 * convert an archive, compress or decompress one file, and identify a file by its magic
 * bytes.
 *
 * The tools never open a shell: arguments are passed to bz.exe as an argv array, and
 * stdin is closed so that a missing password fails fast instead of waiting for an
 * interactive prompt. Per-tool parameter schemas are built from one shared field table,
 * so a parameter that a tool does not declare can never reach its implementation.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import Schema from '@deepseek-ai/schemastery';

/** Cordis plugin name. */
export const name = 'bandizip';

/**
 * Services required to register the tools, resolve the session directory, and read the
 * row's live configuration (`configEditor` backs {@link readRowConfig}).
 */
export const inject = ['tools', 'workingDirectory', 'configEditor'];

/**
 * A linked plugin cannot resolve `@deepseek-ai/schemastery` from the dsh install,
 * so it is vendored under this package's node_modules (see VENDORED.md). Without
 * this export the plugin had no Configuration projection at all and `bzPath`
 * could never be set from the Settings page.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile()
    .description('关闭后不注册 bandizip 工具；其余设置保留。'),
  bzPath: Schema.string().default('').volatile()
    .description('bz.exe full path; empty auto-detects the standard Bandizip install.'),
  timeoutSeconds: Schema.natural().default(900).min(1).max(86400).volatile()
    .description('每次 bz.exe 调用的最长等待秒数（1-86400）。超过后进程被杀，调用以超时失败。'),
  maxOutputChars: Schema.natural().default(12000).min(500).max(200000).volatile()
    .description('回传给模型的输出上限（字符，500-200000）。超出部分截断，并在末尾标注总长度。'),
  allowArchiveOverwrite: Schema.boolean().default(false).volatile()
    .description('允许 create 覆盖已存在的同名压缩包。关闭时即使显式传 overwrite:"overwrite" 也会被拒绝，用来防止误删旧包。'),
  allowPassword: Schema.boolean().default(true).volatile()
    .description('是否允许把密码交给 bz.exe。关闭后任何带 password 的调用都会失败；密码以 argv 传递，本机其它进程可见。'),
  restrictToWorkspace: Schema.boolean().default(false).volatile()
    .description('拒绝工作区之外的 archive / files / destination。开启后会挡掉工作区外的合法跨盘操作，只在需要强边界时启用。'),
  maxExtractBytes: Schema.natural().default(0).volatile()
    .description('解压前的压缩炸弹上限：把所有条目声明的解压后大小相加，超过该字节数就拒绝整包。0 = 不检查。'
      + '它读的是压缩包自己声明的尺寸，异常包也可能谎报，所以它是防线之一而不是唯一防线。'),
  rejectSymlinkEntries: Schema.boolean().default(true).volatile()
    .description('解压前拒绝含符号链接条目的压缩包。符号链接可以把后续写入带到目标目录之外。'
      + '只有 zip / zipx / tar 能检查（读中央目录的 Unix 模式位或 tar 头的 typeflag）；7z 等格式不做此检查，此时该项不起作用。'),
});

const MAX_OUTPUT_CHARS = 12000;
/** Hard ceiling for the configurable output cap; the schema enforces the same bound. */
const MAX_OUTPUT_CHARS_LIMIT = 200000;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
/**
 * setTimeout stores its delay in a signed 32-bit int and silently rewrites anything above
 * this to 1 ms, which would kill every call instantly.
 */
const MAX_TIMEOUT_SECONDS = 86400;
/** bz's own default level when the caller names none. */
const DEFAULT_LEVEL = 5;
const BANNER = /^bz [0-9][^\r\n]*Bandisoft[^\r\n]*\r?\n?/gim;
/** bz 的清单结尾行，例如 "180 files, 4 folders"。 */
const COUNT_LINE = /(\d+)\s+files?,\s*(\d+)\s+folders?/i;
/** 默认解压目录要剥掉的压缩包扩展名；tar 必须在列表里，否则目标会等于压缩包本身。 */
const ARCHIVE_EXTENSION = /\.(tar\.gz|tar\.bz2|tgz|tbz2?|tar|zipx?|7z|lzh|lha|iso|gz|xz|rar|exe)$/i;

/** Formats bz can WRITE with `-fmt:`. Reading also covers rar and other formats. */
const FORMATS = ['zip', 'zipx', 'exe', 'tar', 'tgz', 'lzh', 'iso', '7z', 'gz', 'xz'];
const ENCODINGS = ['auto', 'utf-8', 'gbk'];
/** Formats `compress_file` / `decompress_file` handle as a single stream. */
const STREAM_FORMATS = ['gz', 'xz', 'zstd'];

const OVERWRITE_SWITCH = {
  overwrite: '-aoa',
  skip: '-aos',
  rename: '-aou',
};

const FORMAT_BY_EXTENSION = {
  '.zip': 'zip',
  '.zipx': 'zipx',
  '.exe': 'exe',
  '.tar': 'tar',
  '.tgz': 'tgz',
  '.tbz': 'tgz',
  '.tbz2': 'tgz',
  '.lzh': 'lzh',
  '.lha': 'lzh',
  '.iso': 'iso',
  '.7z': '7z',
  '.gz': 'gz',
  '.xz': 'xz',
  '.rar': 'rar',
  '.zst': 'zstd',
  '.zstd': 'zstd',
  '.bz2': 'bzip2',
  '.cab': 'cab',
};

/** bz's own spelling of a format (`Archive format: Zip/Zipx`) mapped back to ours. */
const FORMAT_BY_ENGINE_NAME = {
  'zip/zipx': 'zip',
  zip: 'zip',
  zipx: 'zipx',
  '7z': '7z',
  rar: 'rar',
  tar: 'tar',
  tgz: 'tgz',
  tbz: 'tgz',
  'tar.gz': 'tgz',
  gzip: 'gz',
  gz: 'gz',
  xz: 'xz',
  lzh: 'lzh',
  lha: 'lzh',
  iso: 'iso',
  cab: 'cab',
  bzip2: 'bzip2',
  zstd: 'zstd',
  exe: 'exe',
};

/** Formats with no password concept at all: reporting `false` beats an `unknown` guess. */
const NO_ENCRYPTION_FORMATS = new Set(['tar', 'tgz', 'gz', 'xz', 'bzip2', 'zstd', 'iso']);
/** Formats where "run bz t without a password" is the only available probe. */
const PROBED_ENCRYPTION_FORMATS = new Set(['7z', 'rar', 'lzh', 'cab', 'zip', 'zipx']);
/** A bz `t` trial costs a full pass over the archive, so remember the verdict per file. */
const ENCRYPTION_TRIALS = new Map();

/**
 * Reading a ZIP central directory into memory is the only place this plugin loads a
 * whole structure; a ceiling keeps a hostile archive from turning it into a memory bomb.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
/** Upper bound for the tar header walk, so a crafted archive cannot spin the scan. */
const MAX_TAR_HEADERS = 200000;

/** Resolve the console executable: explicit config, environment, then the standard installs. */
function resolveBzPath(configured) {
  const candidates = [];
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim());
  const fromEnv = process.env.BANDIZIP_BZ;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim());
  candidates.push(
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Bandizip', 'bz.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Bandizip', 'bz.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Bandizip', 'bz.exe'),
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate; // bare name: let the OS resolve it from PATH
    }
  }
  throw new Error(
    'Bandizip console tool bz.exe was not found in the standard install locations. Install Bandizip, '
      + 'or set bzPath (bundle config) or the BANDIZIP_BZ environment variable to the full path of bz.exe; '
      + 'a bare name such as "bz.exe" is resolved through PATH.',
  );
}

/** Sessions resolve relative paths against their own working directory. */
function sessionDirectory(ctx, exec) {
  try {
    const session = exec?.agent?.session;
    if (session) return ctx.workingDirectory.get(session);
  } catch {
    // fall through: no live session (for example a call outside a model step)
  }
  return process.cwd();
}

/** Decode bz's output with an explicit encoding, or the utf-8→gbk fallback. */
function decodeWith(buffer, encoding) {
  if (!buffer || buffer.length === 0) return '';
  const requested = encoding === 'utf-8' || encoding === 'gbk' ? encoding : 'auto';
  if (requested !== 'auto') {
    try {
      return new TextDecoder(requested).decode(buffer);
    } catch (error) {
      if (requested === 'gbk') {
        try {
          return new TextDecoder('gb18030').decode(buffer);
        } catch {
          // fall through to the automatic path
        }
      }
      throw new Error(`Unsupported encoding "${encoding}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/** Backwards-compatible default decoder. */
function decode(buffer) {
  return decodeWith(buffer, 'auto');
}

/** 只做规范化（换行、banner、多余空行）；截断是另一步，filter 和计数必须在未截断文本上做。 */
function normalizeOutput(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(BANNER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** This bundle's package name, matched against a Loader row's `options.name`. */
const PACKAGE_NAME = '@local/bandizip';

/**
 * Read one Config field. A `.volatile()` field arrives as a live reference (`{ get() }`)
 * rather than a plain value, so `config.x === false` would never hold; a plain value is
 * passed through untouched for an embedder that composes this plugin without a Loader.
 * @param value - the field as the Config parser produced it.
 * @returns the field's current scalar value.
 */
function unwrapValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Flatten the parsed Config into plain scalars exactly once, at activation.
 * @param config - the Config handed to `apply`.
 * @returns plain values, with volatile references resolved.
 */
function unwrapConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const plain = {};
  for (const [key, value] of Object.entries(config)) plain[key] = unwrapValue(value);
  return plain;
}

/**
 * Merge the row's CURRENT configuration over the config captured at activation.
 *
 * Every editable field is `.volatile()`, and a volatile write does NOT re-run `apply`.
 * Module-level state assigned in `apply` would therefore freeze at the activation value,
 * so the Loader entry's `options.config` is the live truth and must be re-read per call.
 * The captured config only supplies the schema defaults (and works when no entry is
 * reachable, e.g. an embedder that composes this plugin outside a profile).
 *
 * @param ctx - this plugin's context, whose `configEditor` lists the profile rows.
 * @param fallback - the config captured at activation.
 * @returns the merged, already-clamped configuration.
 */
function readRowConfig(ctx, fallback) {
  const merged = {
    enabled: fallback?.enabled !== false,
    bzPath: typeof fallback?.bzPath === 'string' ? fallback.bzPath : '',
    timeoutSeconds: clampTimeoutSeconds(fallback?.timeoutSeconds),
    maxOutputChars: clampMaxOutputChars(fallback?.maxOutputChars),
    allowArchiveOverwrite: fallback?.allowArchiveOverwrite === true,
    allowPassword: fallback?.allowPassword !== false,
    restrictToWorkspace: fallback?.restrictToWorkspace === true,
    maxExtractBytes: Number.isSafeInteger(fallback?.maxExtractBytes) && fallback.maxExtractBytes > 0 ? fallback.maxExtractBytes : 0,
    rejectSymlinkEntries: fallback?.rejectSymlinkEntries !== false,
  };
  try {
    const entry = ctx.configEditor.entries()
      .find((candidate) => candidate?.options?.name === PACKAGE_NAME);
    const values = entry?.options?.config;
    if (values?.enabled !== undefined) merged.enabled = values.enabled !== false;
    if (typeof values?.bzPath === 'string') merged.bzPath = values.bzPath;
    if (values?.timeoutSeconds !== undefined) merged.timeoutSeconds = clampTimeoutSeconds(values.timeoutSeconds);
    if (values?.maxOutputChars !== undefined) merged.maxOutputChars = clampMaxOutputChars(values.maxOutputChars);
    if (values?.allowArchiveOverwrite !== undefined) merged.allowArchiveOverwrite = values.allowArchiveOverwrite === true;
    if (values?.allowPassword !== undefined) merged.allowPassword = values.allowPassword !== false;
    if (values?.restrictToWorkspace !== undefined) merged.restrictToWorkspace = values.restrictToWorkspace === true;
    if (values?.maxExtractBytes !== undefined) {
      const bytes = Number(values.maxExtractBytes);
      merged.maxExtractBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    }
    if (values?.rejectSymlinkEntries !== undefined) {
      merged.rejectSymlinkEntries = values.rejectSymlinkEntries !== false;
    }
  } catch {
    // No reachable profile row: keep the activation config.
  }
  return merged;
}

/**
 * A whole number of seconds in 1..86400. `setTimeout` silently rewrites a delay above
 * 2147483647 ms to 1 ms, so an unbounded value would kill every call instantly.
 */
function clampTimeoutSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(value), MAX_TIMEOUT_SECONDS);
}

/** A whole number of characters in 500..200000. */
function clampMaxOutputChars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 500) return MAX_OUTPUT_CHARS;
  return Math.min(Math.floor(value), MAX_OUTPUT_CHARS_LIMIT);
}

function truncateOutput(text, maxOutputChars) {
  const limit = maxOutputChars;
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[... output truncated: ${text.length} characters total]`,
    truncated: true,
  };
}

function cleanOutput(text, maxOutputChars) {
  return truncateOutput(normalizeOutput(text), maxOutputChars);
}

/** bz 把条目总数印在清单最后一行，例如 "180 files, 4 folders"。 */
function countsFromListing(text) {
  const match = COUNT_LINE.exec(text);
  return match ? { files: Number(match[1]), folders: Number(match[2]) } : undefined;
}

/**
 * 把清单里每一条目解析成结构化记录。
 * bz 的 `l` 输出形如：
 *   2026-11-18 20:32:40 D___            0            0 src\
 *   2026-11-18 20:32:40 A___            5            5 src\a.txt
 * 表头到分隔线为止；条目行的属性列是 D___ / A___ 等 4 字符标记。
 * 原始文本（未截断）进来，保证大包所有条目都被解析。
 */
function parseListing(text) {
  const lines = text.split('\n');
  const firstSep = lines.findIndex((line) => /^-{5,}/.test(line));
  const entries = [];
  const linePattern = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/;
  for (let i = firstSep === -1 ? 0 : firstSep + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    // The trailing totals line ("25 29 4 files, 3 folders") is not an entry.
    if (COUNT_LINE.test(trimmed)) continue;
    const match = linePattern.exec(trimmed);
    if (!match) continue;
    const [, attr, sizeStr, compSizeStr, rawName] = match;
    const name = rawName.trim().replace(/\\/g, '/');
    if (name === '' || COUNT_LINE.test(name)) continue;
    const isDir = /^D/.test(attr);
    entries.push({
      name,
      size: Number(sizeStr),
      compressedSize: Number(compSizeStr),
      isDir,
    });
  }
  return entries;
}

/**
 * The aggregates `stats: true` reports, all derived from an already-parsed listing.
 *
 * The old `preview` action computed exactly this shape from `bz l`; folding it into
 * `list_archive` keeps one listing per call instead of two commands that could disagree.
 *
 * @param entries - every parsed entry of the archive (unfiltered, unpaged).
 * @returns byExtension, topLevelDirs, largest and the file byte total.
 */
function archiveStats(entries) {
  const files = entries.filter((entry) => !entry.isDir);
  const extensionMap = new Map();
  for (const entry of files) {
    const base = entry.name.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    const extension = dot > 0 ? base.slice(dot).toLowerCase() : '<none>';
    const current = extensionMap.get(extension) ?? { extension, count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += entry.size;
    extensionMap.set(extension, current);
  }
  const byExtension = [...extensionMap.values()]
    .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension));
  const topMap = new Map();
  for (const entry of entries) {
    const top = entry.name.split('/')[0];
    if (!top) continue;
    const current = topMap.get(top) ?? { name: top, entryCount: 0, uncompressedBytes: 0 };
    current.entryCount += 1;
    current.uncompressedBytes += entry.isDir ? 0 : entry.size;
    topMap.set(top, current);
  }
  const topLevelDirs = [...topMap.values()]
    .sort((a, b) => b.entryCount - a.entryCount || a.name.localeCompare(b.name));
  const largest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((entry) => ({ name: entry.name, size: entry.size }));
  const totalUncompressedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  return { byExtension, topLevelDirs, largest, totalUncompressedBytes };
}

/** 统一路径为正斜杠、相对包根，去掉开头的 "./"。 */
function normalizeEntryPath(raw) {
  return String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Normalise a bz `-v:` volume size.
 *
 * bz accepts a plain byte count or a `k`/`m`/`g`/`t` suffix (`-v:100MB`,
 * `-v:1440k`). We do not compute anything here — only reject a value that would
 * reach the command line as something bz cannot mean, because a stray `-` there
 * would be read as the next switch.
 *
 * @param raw - user-supplied size.
 * @returns the normalised token, or `undefined` when the argument is absent.
 */
function parseVolumeSize(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error('volumeSize must be a string such as "100MB" or a number of bytes.');
  }
  const text = String(raw).trim();
  if (text === '' || text.startsWith('-')) throw new Error(`Invalid volumeSize: ${text}`);
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(text);
  if (!match || Number(match[1]) <= 0) {
    throw new Error(`Invalid volumeSize "${text}" — use bytes or a size like 100MB, 1440k, 2GB.`);
  }
  const value = Number(match[1]);
  const unit = match[2].toUpperCase().replace(/B$/, '');
  return unit === '' ? String(Math.round(value)) : `${value}${unit}`;
}

/**
 * A digest spec the caller wants the artifact checked against.
 *
 * Two shapes are accepted because both are what people paste: `sha256:<hex>` and a bare
 * hex digest, whose length identifies the algorithm (no algorithm can be inferred from a
 * bare hex string otherwise, and silently assuming sha256 would report a false mismatch).
 */
const ALGORITHM_BY_HEX_LENGTH = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };

function parseChecksum(spec) {
  if (spec === undefined || spec === null || spec === '') return undefined;
  if (typeof spec !== 'string') throw new Error(`checksum must be a string, got ${JSON.stringify(spec)}.`);
  const text = spec.trim().toLowerCase();
  if (text === '') return undefined;
  let algorithm;
  let hex;
  if (text.includes(':')) {
    const parts = text.split(':');
    if (parts.length !== 2) throw new Error(`checksum must be "<algorithm>:<hex>" or a bare hex digest, got "${spec}".`);
    [algorithm, hex] = parts;
  } else {
    hex = text;
    algorithm = ALGORITHM_BY_HEX_LENGTH[hex.length];
    if (algorithm === undefined) {
      throw new Error(
        `Cannot infer an algorithm from a ${hex.length}-character hex digest; pass "<algorithm>:<hex>" `
          + '(md5, sha1, sha256, sha512).',
      );
    }
  }
  if (!/^(md5|sha1|sha256|sha512)$/.test(algorithm)) {
    throw new Error(`Unsupported checksum algorithm "${algorithm}"; use md5, sha1, sha256, or sha512.`);
  }
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`checksum digest must be hex, got "${hex}".`);
  return { algorithm, hex };
}

/**
 * Stream one file through a digest, so a large archive never has to be held in
 * memory. Same shape as the helper the download plugin uses.
 *
 * @param filePath - file to hash.
 * @param algorithm - node:crypto algorithm name.
 * @returns hex digest.
 */
async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Walk a directory and return `relative/path -> { size, sha256 }` for every
 * regular file, so a packed tree can be compared against what comes back out.
 *
 * @param root - directory to walk.
 * @returns map of relative path to its size and digest.
 */
async function digestTree(root) {
  const out = new Map();
  const walk = async (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        out.set(relative, { size: statSync(absolute).size, sha256: await hashFile(absolute, 'sha256') });
      }
    }
  };
  await walk(root, '');
  return out;
}

const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_S_IFMT = 0xf000;
const ZIP_S_IFLNK = 0xa000;
/** General purpose bit 0 of a central-directory record. */
const ZIP_FLAG_ENCRYPTED = 0x0001;

/** Read exactly `buffer.length` bytes at `position`, or fewer at end of file. */
function readAt(fd, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    const read = readSync(fd, buffer, total, buffer.length - total, position + total);
    if (read <= 0) break;
    total += read;
  }
  return total;
}

/**
 * Scan a ZIP/ZIPX central directory for the two facts `bz l` cannot report.
 *
 * `bz l` prints the directory flag and the DOS archive bit only: an encrypted entry and a
 * symlink entry both look exactly like a regular file there. The central directory keeps
 * the general-purpose bit flag (bit 0 = encrypted) and the Unix mode (high 16 bits of the
 * external attributes), so it is the one place both facts survive.
 *
 * Only the tail (for the end-of-central-directory record) and the directory itself are
 * read, so archive size does not decide memory use.
 *
 * Returns `{ checked: false, reason }` when the file is not a ZIP, is ZIP64, or is
 * malformed — callers must not read "could not check" as "clean".
 *
 * @param filePath - archive on disk.
 */
function zipCentralScan(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    return { checked: false, reason: `cannot read archive: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const size = statSync(filePath).size;
    // EOCD is 22 bytes plus up to 64 KiB of trailing comment.
    const tailLength = Math.min(size, 0xffff + 22);
    if (tailLength < 22) return { checked: false, reason: 'file is too small to hold a ZIP end record' };
    const tail = Buffer.alloc(tailLength);
    if (readAt(fd, tail, size - tailLength) !== tailLength) {
      return { checked: false, reason: 'cannot read the end of the file' };
    }
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === ZIP_SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) return { checked: false, reason: 'not a zip archive (no end-of-central-directory record)' };

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      return { checked: false, reason: 'zip64 central directory is not scanned' };
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      return {
        checked: false,
        reason: `central directory is ${cdSize} bytes, over the ${MAX_CENTRAL_DIRECTORY_BYTES}-byte scan ceiling`,
      };
    }
    const cd = Buffer.alloc(cdSize);
    if (readAt(fd, cd, cdOffset) !== cdSize) {
      return { checked: false, reason: 'central directory is shorter than its end record claims' };
    }

    const symlinks = [];
    let encrypted = 0;
    let p = 0;
    for (let n = 0; n < count; n += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== ZIP_SIG_CENTRAL) {
        return { checked: false, reason: `central directory malformed at entry ${n + 1}` };
      }
      const flags = cd.readUInt16LE(p + 8);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const externalAttributes = cd.readUInt32LE(p + 38);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
      if ((flags & ZIP_FLAG_ENCRYPTED) !== 0) encrypted += 1;
      if (((externalAttributes >>> 16) & ZIP_S_IFMT) === ZIP_S_IFLNK) symlinks.push(name);
      p += 46 + nameLength + extraLength + commentLength;
    }
    return { checked: true, symlinks, encrypted, entryCount: count };
  } catch (error) {
    return { checked: false, reason: `central directory scan failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

/**
 * Names of the symlink entries in a tar archive.
 *
 * A tar entry records its type in the header's typeflag column ('2' = symbolic link), which
 * `bz l` again does not surface. Skipping (rather than rejecting) those entries needs their
 * names, so the header chain is walked here.
 *
 * GNU long names (`L`/`K`) and pax headers are walked past by their own size fields; a
 * symlink whose name arrived through one of those is reported with the stored short name,
 * which is what a reject message needs anyway. Not checked: 7z and other formats.
 *
 * @param filePath - archive on disk.
 */
function tarSymlinkEntries(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    return { checked: false, reason: `cannot read archive: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const size = statSync(filePath).size;
    const header = Buffer.alloc(512);
    const cString = (buffer, start, end) => buffer.toString('latin1', start, end).replace(/\0.*$/s, '').trim();
    const symlinks = [];
    let offset = 0;
    let headers = 0;
    while (offset + 512 <= size && headers < MAX_TAR_HEADERS) {
      if (readAt(fd, header, offset) !== 512) break;
      headers += 1;
      // Two zero blocks end the archive; a single one is tolerated as a stop signal.
      if (header.every((byte) => byte === 0)) break;
      const typeflag = header.toString('latin1', 156, 157);
      const name = cString(header, 0, 100);
      const prefix = cString(header, 345, 500);
      if (typeflag === '2') {
        const fullName = prefix === '' ? name : `${prefix}/${name}`;
        if (fullName !== '') symlinks.push(fullName);
        if (symlinks.length >= 1000) break;
      }
      const declared = parseInt(cString(header, 124, 136), 8);
      const entrySize = Number.isFinite(declared) && declared > 0 ? declared : 0;
      offset += 512 + Math.ceil(entrySize / 512) * 512;
    }
    return { checked: true, symlinks };
  } catch (error) {
    return { checked: false, reason: `tar header scan failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

/** Dispatch the symlink scan to the format that can answer it. */
function symlinkEntriesOf(filePath, format) {
  if (format === 'zip' || format === 'zipx' || format === 'exe') return zipCentralScan(filePath);
  if (format === 'tar' || format === 'tgz') return tarSymlinkEntries(filePath);
  return { checked: false, reason: `symlink entries are not scanned for format "${format}"` };
}

/** Read the first `length` bytes of a file without loading the rest of it. */
function readHead(filePath, length) {
  const fd = openSync(filePath, 'r');
  try {
    const size = statSync(filePath).size;
    const wanted = Math.min(size, length);
    const buffer = Buffer.alloc(wanted);
    readAt(fd, buffer, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Identify an archive by its magic bytes alone.
 *
 * Extension-based guessing was the old behaviour and it is wrong exactly when it matters:
 * a `.zip` that is really a 7z, or a download with no extension at all. Signatures are
 * checked longest-offset-first only where they collide, which none of these do.
 *
 * @param filePath - file on disk.
 * @returns `{ format, confidence: 'magic' }`, or `null` when no signature matches.
 */
export function sniffFormat(filePath) {
  let head;
  try {
    head = readHead(filePath, 0x8001 + 5);
  } catch {
    return null;
  }
  const at = (offset, ...bytes) => {
    if (head.length < offset + bytes.length) return false;
    return bytes.every((byte, index) => head[offset + index] === byte);
  };
  const ascii = (offset, text) => {
    if (head.length < offset + text.length) return false;
    return head.toString('latin1', offset, offset + text.length) === text;
  };

  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b
    && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)
    && (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)) {
    return { format: 'zip', confidence: 'magic' };
  }
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { format: '7z', confidence: 'magic' };
  if (at(0, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return { format: 'rar', confidence: 'magic' };
  if (at(0, 0x1f, 0x8b)) {
    // The gzip container says nothing about payload; a tar payload is what makes it a tgz.
    return { format: /\.(tar\.gz|tgz)$/i.test(filePath) ? 'tgz' : 'gz', confidence: 'magic' };
  }
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return { format: 'xz', confidence: 'magic' };
  if (at(0, 0x42, 0x5a, 0x68)) return { format: 'bzip2', confidence: 'magic' };
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return { format: 'zstd', confidence: 'magic' };
  // LZH carries no leading signature: the method id ("-lh") sits at offset 2.
  if (at(2, 0x2d, 0x6c, 0x68)) return { format: 'lzh', confidence: 'magic' };
  if (ascii(0, 'MSCF')) return { format: 'cab', confidence: 'magic' };
  if (ascii(0x8001, 'CD001')) return { format: 'iso', confidence: 'magic' };
  if (ascii(257, 'ustar')) return { format: 'tar', confidence: 'magic' };
  // A self-extracting archive is a ZIP behind an MZ stub; bz reads it as Zip/Zipx.
  if (ascii(0, 'MZ')) return { format: 'exe', confidence: 'magic' };
  return null;
}

/** The engine's own answer: the `Archive format:` line of `bz l`. */
function formatFromListing(text) {
  const match = /^Archive format:\s*(.+?)\s*$/im.exec(text);
  if (!match) return undefined;
  return FORMAT_BY_ENGINE_NAME[match[1].toLowerCase()];
}

/**
 * Ask the format of a file: magic bytes first, then `bz l`, then the extension.
 *
 * The extension is last on purpose — it is the least trustworthy source, so when only it
 * matches, `isArchive` is false and the caller knows the bytes did not back the answer.
 *
 * @param session - per-call context.
 * @param filePath - file on disk.
 * @returns `{ format, confidence, isArchive }`.
 */
async function detectFormatOf(session, filePath) {
  const sniffed = sniffFormat(filePath);
  if (sniffed !== null) return { format: sniffed.format, confidence: 'magic', isArchive: true };
  let engine;
  try {
    const listed = await session.run(['l', '-y', filePath]);
    engine = formatFromListing(normalizeOutput(decodeWith(listed.output, session.encoding)));
  } catch {
    // bz missing or refusing: the extension is still worth trying.
  }
  if (engine !== undefined) return { format: engine, confidence: 'engine', isArchive: true };
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz')) return { format: 'tgz', confidence: 'extension', isArchive: false };
  const byExtension = FORMAT_BY_EXTENSION[path.extname(lower)];
  if (byExtension !== undefined) return { format: byExtension, confidence: 'extension', isArchive: false };
  // Nothing recognised it: that is an answer ("this is not an archive"), not a failure. The
  // caller learns more from isArchive:false than from an error it has to read as an answer.
  return {
    format: 'unknown',
    confidence: 'unknown',
    isArchive: false,
    note: 'No known magic bytes matched, bz.exe could not list it, and the extension is not an archive one.',
  };
}

/**
 * Decide whether an archive is encrypted.
 *
 * `bz l` never marks encryption (verified against bz 7.47: the Attr column stays `A___` for
 * an encrypted ZIP), so each format is asked the only way it can answer:
 * - ZIP/ZIPX: general-purpose bit 0 of the central directory (see {@link zipCentralScan}).
 * - 7z / RAR / LZH / CAB: no header this plugin parses, so `bz t` without a password is run;
 *   a password error means encrypted, a clean pass means not. Cached per (path, size, mtime)
 *   because the trial costs a full pass.
 * - tar and the single-stream formats: no password concept, so `false`.
 *
 * A failed probe never throws: the caller gets `'unknown'` and an evidence tag.
 *
 * @param session - per-call context.
 * @param archivePath - archive on disk.
 * @param format - format name, used to pick the probe.
 * @returns `{ encrypted: boolean|'unknown', source, note? }`.
 */
async function resolveEncryption(session, archivePath, format) {
  if (format === 'zip' || format === 'zipx' || format === 'exe') {
    const scan = zipCentralScan(archivePath);
    if (!scan.checked) return { encrypted: 'unknown', source: 'zip-central-directory', note: scan.reason };
    return { encrypted: scan.encrypted > 0, source: 'zip-central-directory' };
  }
  if (NO_ENCRYPTION_FORMATS.has(format)) return { encrypted: false, source: 'format-cannot-encrypt' };
  if (!PROBED_ENCRYPTION_FORMATS.has(format)) {
    return { encrypted: 'unknown', source: 'not-probed', note: `encryption is not probed for format "${format}"` };
  }
  let cacheKey;
  try {
    const info = statSync(archivePath);
    cacheKey = `${archivePath}|${info.size}|${info.mtimeMs}`;
    const cached = ENCRYPTION_TRIALS.get(cacheKey);
    if (cached !== undefined) return cached;
  } catch {
    cacheKey = undefined;
  }
  let verdict;
  try {
    const trial = await session.run(['t', '-y', archivePath]);
    const text = decodeWith(trial.output, session.encoding);
    if (trial.exitCode === 0) {
      verdict = { encrypted: false, source: 'bz-test-trial' };
    } else if (/password/i.test(text)) {
      verdict = { encrypted: true, source: 'bz-test-trial' };
    } else {
      verdict = {
        encrypted: 'unknown',
        source: 'bz-test-trial',
        note: `bz t exited with code ${trial.exitCode} and did not mention a password`,
      };
    }
  } catch (error) {
    verdict = {
      encrypted: 'unknown',
      source: 'bz-test-trial',
      note: error instanceof Error ? error.message : String(error),
    };
  }
  if (cacheKey !== undefined) {
    // Keep the cache from becoming a leak in a long-lived host process.
    if (ENCRYPTION_TRIALS.size > 64) ENCRYPTION_TRIALS.clear();
    ENCRYPTION_TRIALS.set(cacheKey, verdict);
  }
  return verdict;
}

/**
 * Split volumes of a ZIP: bz writes `name.z01`, `name.z02`, … and keeps `name.zip` as the
 * last fragment, so the sibling files are the only record that a `.zip` is not complete.
 *
 * @param archivePath - the archive itself.
 * @returns `{ split, parts }`, where parts counts every fragment including the `.zip`.
 */
function zipVolumes(archivePath) {
  const extension = path.extname(archivePath).toLowerCase();
  if (extension !== '.zip' && extension !== '.zipx') return { split: false, parts: 1 };
  const stem = path.basename(archivePath, path.extname(archivePath));
  try {
    const siblings = readdirSync(path.dirname(archivePath));
    const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.z\\d{2,}$`, 'i');
    const fragments = siblings.filter((entry) => pattern.test(entry)).length;
    if (fragments === 0) return { split: false, parts: 1 };
    return { split: true, parts: fragments + 1 };
  } catch {
    return { split: false, parts: 1 };
  }
}

/** 把通配模式（* 与 **）编译成 RegExp；* 不跨 /，** 跨 /。 */
function compileGlob(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/** bz 把 warning 混在正常输出里；只看退出码 1 并不知道它丢了哪些文件。 */
function warningsOf(text) {
  return text.split('\n').filter((line) => /^(Warning|Error)\b/.test(line.trim()));
}

/** -l 只接受 0..9 的整数；静默夹取会让调用方以为限定了别的级别。 */
function parseLevel(requested) {
  // bz's own default is the documented "when omitted" behaviour; the caller
  // decides per archive and says so, rather than inheriting an operator setting.
  if (requested === undefined || requested === null) return DEFAULT_LEVEL;
  if (!Number.isInteger(requested) || requested < 0 || requested > 9) {
    throw new Error(`level must be an integer from 0 to 9, got ${JSON.stringify(requested)}.`);
  }
  return requested;
}

/**
 * Resolve an optional integer tool argument, rejecting non-integers and values
 * outside [min, max]. Used for `limit` / `offset` / `timeoutSeconds`.
 */
function parseOptionalInt(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * A label for the call card. `path.win32.basename` leaves a forward-slash path
 * whole ("C:/x/y.zip" → "C:/x/y.zip" on win32), which would leak the directory
 * into a title meant to show a filename.
 */
function archiveLabel(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').split('/').pop() ?? '';
}

/**
 * bz parses its own command line and eats an embedded double quote, so `-p:a"b`
 * fails with "Parameter Paring Error" (exit 12) and no archive is produced
 * (verified against bz 7.47). Spaces, &, |, ^, %, ;, <, \ and : all pass through
 * fine via argv, so only this one character needs a guard.
 */
function passwordArg(password, allowPassword = true) {
  if (allowPassword === false) {
    throw new Error(
      'Passing a password is disabled by the plugin configuration (allowPassword: false). '
        + 'Enable it on the plugin page, or repack without a password.',
    );
  }
  if (password.includes('"')) {
    throw new Error(
      'password must not contain a double quote ("): bz.exe cannot receive it as an argv value. '
        + 'Use a password without " or pack manually.',
    );
  }
  return `-p:${password}`;
}

function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * bz 的 `c` 会把自己的输出也打进去（只给一条 warning、留下半截条目），
 * 这种输入直接拒绝，别产出坏压缩包。
 */
function assertNotArchive(source, archivePath) {
  if (path.resolve(source).toLowerCase() === archivePath.toLowerCase()) {
    throw new Error(
      `Refusing to add the archive itself: ${archivePath}. Choose another name or another source.`,
    );
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(source).isDirectory();
  } catch {
    // 不存在或不可读：交给调用方的 existsSync 与 bz 自己报错
  }
  if (!isDirectory) return;
  const relative = path.relative(source, archivePath);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(
      `Archive ${archivePath} is inside the source folder ${source}, so it would be archived into itself. `
        + 'Move the archive outside that folder, or list the files to add explicitly.',
    );
  }
}

/**
 * Refuse a resolved path that lies outside the session working directory.
 * Only consulted when `restrictToWorkspace` is on: a legal cross-drive operation
 * (`D:\in` → `E:\out`) legitimately leaves the workspace, so this is a boundary a
 * person opts into, never a default.
 * @param target - an already resolved absolute path.
 * @param cwd - the session working directory.
 * @param what - the argument name, for the message.
 */
function assertInsideWorkspace(target, cwd, what) {
  const relative = path.relative(cwd, target);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!inside) {
    throw new Error(
      `${what} is outside the session working directory: ${target}. `
        + 'Turn off restrictToWorkspace on the plugin page, or use a path inside the workspace.',
    );
  }
}

/**
 * List an archive once, returning the normalized full (UNTRUNCATED) text plus
 * the parsed entry records. Every structured feature (pagination, diff, dry-run,
 * extract manifest) builds on this function.
 */
async function listArchive(run, archivePath, password, allowPassword, encoding) {
  const argv = ['l', '-y'];
  if (password) argv.push(passwordArg(password, allowPassword));
  argv.push(archivePath);
  const result = await run(argv);
  const normalized = normalizeOutput(decodeWith(result.output, encoding));
  return {
    exitCode: result.exitCode,
    ok: result.exitCode === 0,
    text: normalized,
    entries: parseListing(normalized),
    counts: countsFromListing(normalized),
  };
}

/**
 * Create-overwrite gate shared by `create` (fresh) and `convert` (target).
 * Checks both the config switch and the explicit `overwrite:"overwrite"` request.
 */
function assertCreateOverwrite(artifactPath, existedBefore, overwrite, settings) {
  if (!existedBefore) return;
  if (settings.allowArchiveOverwrite === false) {
    throw new Error(
      `Archive already exists: ${artifactPath}. Replacing it is disabled by the plugin `
        + 'configuration (allowArchiveOverwrite: false). Enable it on the plugin page, '
        + 'or choose another archive name.',
    );
  }
  if (overwrite !== 'overwrite') {
    throw new Error(
      `Archive already exists: ${artifactPath}. Pass overwrite:"overwrite" to replace it, `
        + 'or choose another archive name.',
    );
  }
}

/**
 * Run bz.exe with closed stdin so an interactive prompt can never block the turn.
 * Output is captured through a temporary file instead of pipes: the Harness host may run
 * under a sandbox that denies pipe creation between processes, while file handles work there.
 */
function runBz(executable, args, { cwd, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const logPath = path.join(
      os.tmpdir(),
      `dsh-bandizip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    );
    let fd;
    let child;
    const cleanup = () => {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(logPath);
      } catch {
        // best effort
      }
    };
    const readLog = () => {
      try {
        return readFileSync(logPath);
      } catch {
        return Buffer.alloc(0);
      }
    };
    try {
      fd = openSync(logPath, 'w');
      child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        signal,
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    // The caller passes the already-clamped duration; this stays a hard guard so a `0`
    // (which `||` would have swallowed as "unset") can never disable the kill timer.
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_TIMEOUT_SECONDS * 1000)
      : DEFAULT_TIMEOUT_SECONDS * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      // 由 close 分支转成显式错误；只 kill 会被当成普通 bz 失败（"exited with code 1"），真实原因就丢了。
      timedOut = true;
      child.kill();
    }, effectiveTimeout);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = readLog();
      cleanup();
      if (timedOut) {
        const tail = decode(output).trim().split('\n').slice(-5).join('\n');
        const error = new Error(
          `bz.exe did not finish within ${effectiveTimeout} ms and was killed.`
            + (tail ? `\nLast output:\n${tail}` : ''),
        );
        error.code = 'BANDIZIP_TIMEOUT';
        reject(error);
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        signal: exitSignal || undefined,
        output,
      });
    });
  });
}

/** Resolve a tool's path argument and apply the optional workspace boundary. */
function resolveTarget(session, value, what) {
  const resolved = path.resolve(session.cwd, String(value));
  if (session.settings.restrictToWorkspace) assertInsideWorkspace(resolved, session.cwd, what);
  return resolved;
}

/** Refuse an existing destination file unless the caller asked for it explicitly. */
function assertCanWriteFile(destinationPath, overwrite) {
  if (!existsSync(destinationPath)) return;
  if (overwrite === true) return;
  throw new Error(
    `Output already exists: ${destinationPath}. Pass overwrite:true to replace it, or choose another destination.`,
  );
}

/** Wrap a zlib stream error with the file that caused it; the bare code is unreadable. */
function zlibFailure(action, filePath, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${action} failed for ${path.basename(filePath)}: ${message}`);
}

/** node:zlib gained zstd in Node 22.15; probe instead of assuming the runtime. */
function requireZstd() {
  if (typeof zlib.createZstdCompress !== 'function' || typeof zlib.createZstdDecompress !== 'function') {
    throw new Error(
      'This Node runtime has no zstd support (needs Node >= 22.15). Use format "gz" or "xz" instead, '
        + 'or run the plugin on a newer Node.',
    );
  }
}

/** One definition per stream format: how to compress, how to decompress, what suffix to use. */
const STREAM_CODECS = {
  gz: {
    suffix: '.gz',
    compress: (level) => zlib.createGzip({ level }),
    decompress: () => zlib.createGunzip(),
  },
  zstd: {
    suffix: '.zst',
    compress: (level) => {
      requireZstd();
      // zstd has no "store" mode, so level 0 means "library default" here, not "no compression".
      const params = level > 0 ? { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } } : undefined;
      return zlib.createZstdCompress(params);
    },
    decompress: () => {
      requireZstd();
      return zlib.createZstdDecompress();
    },
  },
};

/** Which stream format a file name or a magic-byte answer implies. */
function streamFormatOf(filePath) {
  const sniffed = sniffFormat(filePath);
  if (sniffed !== null && STREAM_FORMATS.includes(sniffed.format)) return sniffed.format;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.gz') return 'gz';
  if (extension === '.xz') return 'xz';
  if (extension === '.zst' || extension === '.zstd') return 'zstd';
  return undefined;
}

/** Strip the stream suffix a compressed file carries, for the default output name. */
function stripStreamSuffix(filePath, format) {
  const suffix = format === 'gz' ? /\.gz$/i : format === 'xz' ? /\.xz$/i : /\.(zst|zstd)$/i;
  if (suffix.test(filePath)) return filePath.replace(suffix, '');
  return undefined;
}

// ---------------------------------------------------------------------------- tools

/**
 * `list_archive`.
 *
 * Beyond the listing it answers two questions an agent cannot ask bz: is the archive
 * encrypted, and is it a fragment of a split set.
 */
async function listArchiveTool(session, args) {
  const archivePath = resolveTarget(session, args.archive, 'archive');
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  const listing = await listArchive(
    session.run, archivePath, session.password, session.settings.allowPassword, session.encoding,
  );
  const sniffed = sniffFormat(archivePath);
  const format = sniffed?.format ?? formatFromListing(listing.text) ?? 'unknown';
  const volumes = zipVolumes(archivePath);
  const encryption = await resolveEncryption(session, archivePath, format);

  if (!listing.ok) {
    // An encrypted 7z cannot even be listed without a password; say that instead of
    // reporting a bare bz failure, because the fix is one argument away.
    const note = encryption.encrypted === true
      ? 'The archive is encrypted; call again with password to list its entries.'
      : `bz.exe exited with code ${listing.exitCode}.`;
    const failedText = truncateOutput(listing.text, session.maxOutputChars);
    // The probe's provenance goes into the note: it is a diagnostic, not a result, and a
    // bare tag like "zip-central-directory" only meant anything next to an explanation.
    const failedNote = encryption.note === undefined
      ? `${note} (encryption probed via ${encryption.source})`
      : `${note} (encryption probed via ${encryption.source}: ${encryption.note})`;
    return {
      ok: false,
      archive: archivePath,
      format,
      encrypted: encryption.encrypted,
      volumes,
      entries: [],
      total: 0,
      totalUncompressedBytes: 0,
      note: failedNote,
      output: failedText.text,
      truncated: failedText.truncated,
    };
  }

  const offset = parseOptionalInt(args.offset, 'offset', { min: 0 }) ?? 0;
  const limit = parseOptionalInt(args.limit, 'limit', { min: 1 });
  const filter = typeof args.filter === 'string' && args.filter !== '' ? args.filter.toLowerCase() : undefined;
  const sourceEntries = filter === undefined
    ? listing.entries
    : listing.entries.filter((entry) => entry.name.toLowerCase().includes(filter));
  const total = sourceEntries.length;
  const page = sourceEntries.slice(offset, limit === undefined ? undefined : offset + limit);
  const totalUncompressedBytes = sourceEntries
    .reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size), 0);
  const text = truncateOutput(page.map((entry) => `${entry.isDir ? 'D' : ' '} ${entry.size}\t${entry.name}`).join('\n'), session.maxOutputChars);

  const result = {
    ok: true,
    archive: archivePath,
    format,
    encrypted: encryption.encrypted,
    volumes,
    entries: page,
    total,
    totalUncompressedBytes,
    output: text.text,
    truncated: text.truncated,
  };
  if (offset + page.length < total) result.nextOffset = offset + page.length;
  // Same rule as the failure branch: provenance travels in the note.
  result.note = encryption.note === undefined
    ? `encryption probed via ${encryption.source}`
    : `encryption probed via ${encryption.source}: ${encryption.note}`;
  if (args.stats === true) {
    // Whole archive on purpose: a page-relative aggregate would describe the request, not
    // the archive, and the field names promise the latter.
    const stats = archiveStats(listing.entries);
    result.byExtension = stats.byExtension;
    result.topLevelDirs = stats.topLevelDirs;
    result.largest = stats.largest;
    result.totalUncompressedBytes = stats.totalUncompressedBytes;
  }
  return result;
}

/**
 * `check_archive`.
 *
 * `bz t` is the only command that verifies entry data; `bz l` reads the central directory
 * alone and calls a damaged archive fine. The container check and the optional expected
 * digest are reported side by side because they answer different questions.
 */
async function checkArchiveTool(session, args) {
  const archivePath = resolveTarget(session, args.archive, 'archive');
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  const expected = parseChecksum(args.checksum);
  const argv = ['t', '-y'];
  if (session.password) argv.push(passwordArg(session.password, session.settings.allowPassword));
  argv.push(archivePath);
  const tested = await session.run(argv);
  const decoded = cleanOutput(decode(tested.output), session.maxOutputChars);
  const integrity = tested.exitCode === 0 ? 'ok' : 'failed';
  let checksum;
  if (expected !== undefined) {
    const actual = await hashFile(archivePath, expected.algorithm);
    checksum = {
      algorithm: expected.algorithm,
      expected: expected.hex,
      actual,
      matched: actual === expected.hex,
    };
  }
  const ok = integrity === 'ok' && (checksum === undefined || checksum.matched);
  const result = {
    ok,
    archive: archivePath,
    integrity,
    exitCode: tested.exitCode,
    output: decoded.text,
    truncated: decoded.truncated,
  };
  if (checksum !== undefined) result.checksum = checksum;
  if (checksum !== undefined && !checksum.matched) {
    result.note = `The archive digest does not match: expected ${checksum.algorithm}:${checksum.expected}, `
      + `got ${checksum.actual}. The file on disk is not the one that digest describes.`;
  }
  return result;
}

/**
 * `diff_archive`.
 *
 * bz's listing carries entry names and sizes only, so this compares by (name, size) and
 * says so; two versions of a file with the same size cannot be told apart.
 */
async function diffArchiveTool(session, args) {
  const archivePath = resolveTarget(session, args.archive, 'archive');
  const archive2 = resolveTarget(session, args.archive2, 'archive2');
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  if (!existsSync(archive2)) throw new Error(`Archive not found: ${archive2}`);
  const [left, right] = await Promise.all([
    listArchive(session.run, archivePath, session.password, session.settings.allowPassword, session.encoding),
    listArchive(session.run, archive2, session.password, session.settings.allowPassword, session.encoding),
  ]);
  if (!left.ok || !right.ok) {
    throw new Error(
      `diff failed: ${path.basename(archivePath)} exited ${left.exitCode}, `
        + `${path.basename(archive2)} exited ${right.exitCode}.`,
    );
  }
  const keyOf = (entry) => `${entry.isDir ? 'D:' : 'F:'}${entry.name}`;
  const leftMap = new Map(left.entries.map((entry) => [keyOf(entry), entry]));
  const rightMap = new Map(right.entries.map((entry) => [keyOf(entry), entry]));
  const added = right.entries.filter((entry) => !leftMap.has(keyOf(entry))).map((entry) => ({ name: entry.name, size: entry.size }));
  const removed = left.entries.filter((entry) => !rightMap.has(keyOf(entry))).map((entry) => ({ name: entry.name, size: entry.size }));
  const changed = left.entries
    .filter((entry) => {
      const other = rightMap.get(keyOf(entry));
      return other !== undefined && other.size !== entry.size;
    })
    .map((entry) => ({ name: entry.name, from: entry.size, to: rightMap.get(keyOf(entry)).size }));
  // A pattern with no wildcard is read as a substring, the same way list_archive's filter is:
  // "b.txt" is what a caller means, and a strict glob would silently match nothing.
  const filterText = typeof args.filter === 'string' && args.filter !== '' ? args.filter : undefined;
  const filterPattern = filterText !== undefined && /[*?]/.test(filterText)
    ? compileGlob(normalizeEntryPath(filterText))
    : undefined;
  const filterNeedle = filterText === undefined ? undefined : filterText.toLowerCase();
  const keep = (entry) => {
    if (filterPattern !== undefined) return filterPattern.test(normalizeEntryPath(entry.name));
    if (filterNeedle !== undefined) return normalizeEntryPath(entry.name).toLowerCase().includes(filterNeedle);
    return true;
  };
  const limit = (list) => list.filter(keep).slice(0, 20);
  const note = 'Size-identical content changes are invisible here: bz lists only entry names and sizes, '
    + 'so "changed" means a different size, and same-size edits show up as unchanged.';
  const counts = {
    added: added.filter(keep).length,
    removed: removed.filter(keep).length,
    changed: changed.filter(keep).length,
  };
  return {
    ok: true,
    archive: archivePath,
    archive2,
    counts,
    added: limit(added),
    removed: limit(removed),
    changed: limit(changed),
    note,
  };
}

/**
 * `detect_format`: identify a file by magic bytes, falling back to bz and then the name.
 */
async function detectFormatTool(session, args) {
  const filePath = resolveTarget(session, args.path, 'path');
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const detected = await detectFormatOf(session, filePath);
  const encryption = detected.isArchive
    ? await resolveEncryption(session, filePath, detected.format)
    : { encrypted: false, source: 'not-an-archive' };
  const result = {
    format: detected.format,
    confidence: detected.confidence,
    encryptedGuess: encryption.encrypted,
    isArchive: detected.isArchive,
    size: statSync(filePath).size,
  };
  const notes = [detected.note, encryption.note].filter((note) => typeof note === 'string');
  if (notes.length > 0) result.note = notes.join('; ');
  return result;
}

/**
 * `compress_file`: one file into a gz / xz / zstd stream.
 *
 * gz and zstd run through node:zlib as streams; xz has no Node codec, so bz does that one
 * (still streaming, still no dependency). Level semantics: 0..9 as bz defines them, with
 * zstd's 0 meaning the library default because it has no store mode.
 */
async function compressFileTool(session, args) {
  const sourcePath = resolveTarget(session, args.file, 'file');
  if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
  if (!statSync(sourcePath).isFile()) throw new Error(`file must be a regular file, got a directory: ${sourcePath}`);
  const format = String(args.format);
  if (!STREAM_FORMATS.includes(format)) {
    throw new Error(`format must be one of ${STREAM_FORMATS.join(', ')}, got ${JSON.stringify(args.format)}.`);
  }
  const level = parseLevel(args.level);
  const defaultSuffix = format === 'zstd' ? '.zst' : `.${format}`;
  const destinationPath = args.destination === undefined || args.destination === ''
    ? `${sourcePath}${defaultSuffix}`
    : resolveTarget(session, args.destination, 'destination');
  if (destinationPath.toLowerCase() === sourcePath.toLowerCase()) {
    throw new Error(`destination must differ from the file being compressed: ${sourcePath}`);
  }
  assertCanWriteFile(destinationPath, args.overwrite);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const inputBytes = statSync(sourcePath).size;
  let note;
  if (format === 'xz') {
    // bz writes the stream itself; run it in the source directory so the stored name is
    // the plain file name and not an absolute path.
    const argv = ['c', '-fmt:xz', `-l:${level}`, '-y', destinationPath, `./${path.basename(sourcePath)}`];
    const created = await session.run(argv, path.dirname(sourcePath));
    if (!existsSync(destinationPath)) {
      const decoded = cleanOutput(decode(created.output), session.maxOutputChars);
      throw new Error(
        `bz.exe did not create ${path.basename(destinationPath)} (exit code ${created.exitCode}). `
          + (decoded.text === '' ? '' : `Output:\n${decoded.text}`),
      );
    }
    note = 'xz was compressed by bz.exe: node:zlib has no xz codec.';
  } else {
    const codec = STREAM_CODECS[format];
    try {
      await pipeline(createReadStream(sourcePath), codec.compress(level), createWriteStream(destinationPath));
    } catch (error) {
      try {
        rmSync(destinationPath, { force: true });
      } catch {
        // a partial file is best effort removed; the failure below is the real message
      }
      throw zlibFailure(`Compressing to ${format}`, sourcePath, error);
    }
  }
  const outputBytes = statSync(destinationPath).size;
  return {
    ok: true,
    output: destinationPath,
    format,
    inputBytes,
    outputBytes,
    ratio: inputBytes === 0 ? 0 : Number((outputBytes / inputBytes).toFixed(4)),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * `decompress_file`: one gz / xz / zstd stream back into a file.
 *
 * bz names the unpacked file after the archive with the suffix stripped, so the xz path
 * unpacks into a private temp directory and copies the single result out: extracting
 * straight next to the archive would fight with an existing file of that name.
 */
async function decompressFileTool(session, args) {
  const sourcePath = resolveTarget(session, args.file, 'file');
  if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
  if (!statSync(sourcePath).isFile()) throw new Error(`file must be a regular file, got a directory: ${sourcePath}`);
  const format = args.format === undefined ? streamFormatOf(sourcePath) : String(args.format);
  if (format === undefined) {
    throw new Error(
      `Cannot tell how "${path.basename(sourcePath)}" is compressed: its bytes are not gz/xz/zstd and the `
        + 'name does not end in .gz, .xz, .zst or .zstd. Pass format explicitly.',
    );
  }
  if (!STREAM_FORMATS.includes(format)) {
    throw new Error(`format must be one of ${STREAM_FORMATS.join(', ')}, got ${JSON.stringify(args.format)}.`);
  }
  let destinationPath;
  if (args.destination !== undefined && args.destination !== '') {
    destinationPath = resolveTarget(session, args.destination, 'destination');
  } else {
    const stripped = stripStreamSuffix(sourcePath, format);
    if (stripped === undefined) {
      throw new Error(
        `Cannot derive an output name from ${path.basename(sourcePath)} because it has no .${format} suffix; `
          + 'pass destination.',
      );
    }
    destinationPath = stripped;
  }
  assertCanWriteFile(destinationPath, args.overwrite);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const inputBytes = statSync(sourcePath).size;

  if (format === 'xz') {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-bandizip-xz-'));
    try {
      const argv = ['x', '-y', '-aoa', `-o:${tempDir}`, sourcePath];
      const extracted = await session.run(argv);
      const produced = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else produced.push(absolute);
        }
      };
      walk(tempDir);
      if (produced.length !== 1) {
        const decoded = cleanOutput(decode(extracted.output), session.maxOutputChars);
        throw new Error(
          `bz.exe unpacked ${produced.length} files from ${path.basename(sourcePath)} (exit code `
            + `${extracted.exitCode}); expected exactly one. ` + (decoded.text === '' ? '' : `Output:\n${decoded.text}`),
        );
      }
      copyFileSync(produced[0], destinationPath);
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  } else {
    const codec = STREAM_CODECS[format];
    try {
      await pipeline(createReadStream(sourcePath), codec.decompress(), createWriteStream(destinationPath));
    } catch (error) {
      try {
        rmSync(destinationPath, { force: true });
      } catch {
        // see above
      }
      throw zlibFailure(`Decompressing ${format}`, sourcePath, error);
    }
  }
  const outputBytes = statSync(destinationPath).size;
  return {
    ok: true,
    output: destinationPath,
    format,
    inputBytes,
    outputBytes,
    ratio: inputBytes === 0 ? 0 : Number((outputBytes / inputBytes).toFixed(4)),
  };
}

/**
 * `create_archive`.
 *
 * Unchanged behaviour from the old `create` action: overwrite gate, include globs, append
 * mode, splits, optional `bz t` and an optional full roundtrip comparison. `exclude` is new
 * as a first-class argument; it filters the source expansion, because bz's own `-x:` switch
 * does not apply to the file list built here (verified against bz 7.47).
 */
async function createArchiveTool(session, args) {
  // The host does not validate arguments against `parameters` on this path, so an
  // out-of-contract value would be silently ignored. Refuse it here instead of
  // pretending the call meant something it did not.
  if (args.verify !== undefined && args.verify !== true && args.verify !== false
    && args.verify !== 'roundtrip') {
    throw new Error(`verify must be true, false, or "roundtrip"; got ${JSON.stringify(args.verify)}.`);
  }
  if (args.mode !== undefined && args.mode !== 'create' && args.mode !== 'append') {
    throw new Error(`mode must be "create" or "append", got ${JSON.stringify(args.mode)}.`);
  }
  const archivePath = resolveTarget(session, args.archive, 'archive');
  const format = args.format === undefined
    ? requireFormatFromName(archivePath)
    : parseFormatRequest(args.format);
  const mode = args.mode === 'append' ? 'append' : 'create';
  // Shallow packing selects files by directory depth while include/exclude select them by
  // glob; the two disagree about what "the named folder" means, so refuse the combination
  // instead of inventing an order for them.
  const shallow = args.recursive === false;
  if (shallow && (Array.isArray(args.include) || Array.isArray(args.exclude))) {
    throw new Error(
      'recursive:false cannot be combined with include or exclude: shallow mode packs only the '
        + 'top-level files of each named folder, while include/exclude select by glob, and there is '
        + 'no defensible order to apply them in. Drop one of the two.',
    );
  }
  const artifactPath = ARCHIVE_EXTENSION.test(path.basename(archivePath))
    ? archivePath
    : `${archivePath}.${format}`;
  if (session.settings.restrictToWorkspace) assertInsideWorkspace(artifactPath, session.cwd, 'archive');
  const existedBefore = existsSync(artifactPath);
  // Append reuses bz's `a` command and skips the overwrite gate; fall back to create when
  // the archive does not exist yet.
  const effectiveMode = mode === 'append' && existedBefore ? 'append' : 'create';
  let sources = Array.isArray(args.files) ? args.files.filter((item) => typeof item === 'string') : [];
  const includePatterns = Array.isArray(args.include)
    ? args.include.filter((item) => typeof item === 'string' && item !== '')
    : [];
  const excludePatterns = Array.isArray(args.exclude)
    ? args.exclude.filter((item) => typeof item === 'string' && item !== '')
    : [];

  if (includePatterns.length > 0 || excludePatterns.length > 0) {
    const regexes = includePatterns.map(compileGlob);
    const exclusions = excludePatterns.map(compileGlob);
    const expanded = [];
    // Patterns are relative to the session working directory. Walk cwd so each candidate
    // path is tested as written by the caller, and only descend into the directories the
    // caller named as sources.
    const sourceDirs = sources.map((source) => path.resolve(session.cwd, source));
    const searchable = (dir) => sourceDirs.some((candidate) => {
      const relative = path.relative(candidate, dir);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    const ancestorOfSource = (dir) => sourceDirs.some((candidate) => {
      const relative = path.relative(dir, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    const visitCwd = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const relativePath = path.relative(session.cwd, absolute).split(path.sep).join('/');
        if (session.settings.restrictToWorkspace) assertInsideWorkspace(absolute, session.cwd, 'include match');
        if (entry.isDirectory()) {
          if (searchable(absolute) || ancestorOfSource(absolute)) visitCwd(absolute);
        } else if (searchable(dir)) {
          const matchesInclude = regexes.length === 0 || regexes.some((regex) => regex.test(relativePath));
          const matchesExclude = exclusions.some((regex) => regex.test(relativePath));
          if (matchesInclude && !matchesExclude) expanded.push(absolute);
        }
      }
    };
    visitCwd(session.cwd);
    sources = [...new Set(expanded)];
    if (sources.length === 0) {
      throw new Error(
        `The include/exclude patterns matched no files (include: ${includePatterns.join(', ') || '(none)'}; `
          + `exclude: ${excludePatterns.join(', ') || '(none)'}). Patterns are relative to the session working directory.`,
      );
    }
  }
  if (sources.length === 0) throw new Error('create_archive requires files, or an include pattern that matches files.');
  if (effectiveMode === 'create') assertCreateOverwrite(artifactPath, existedBefore, args.overwrite, session.settings);
  const beforeMtime = existedBefore ? modifiedAt(artifactPath) : undefined;
  const level = parseLevel(args.level);
  const isAppend = effectiveMode === 'append';
  const argv = [isAppend ? 'a' : 'c'];
  if (!isAppend) argv.push(`-fmt:${format}`);
  argv.push(`-l:${level}`);
  const volumeSize = parseVolumeSize(args.volumeSize);
  if (volumeSize !== undefined) argv.push(`-v:${volumeSize}`);
  argv.push('-y');
  // `-r-` alone does NOT stop a directory that is named explicitly from being walked: bz's
  // recursion switch only constrains wildcard expansion, so shallow mode also turns the
  // directory entry into "dir/*" below.
  argv.push(shallow ? '-r-' : '-r');
  if (session.password) argv.push(passwordArg(session.password, session.settings.allowPassword));
  argv.push(artifactPath);
  // What each source is actually queued as. Roundtrip reuses this instead of re-deriving
  // names a second way: the two derivations disagreed for absolute sources, and a correct
  // archive was reported as missing files.
  const queued = [];
  const skipped = [];
  for (const source of sources) {
    const absolute = path.resolve(session.cwd, source);
    if (session.settings.restrictToWorkspace) assertInsideWorkspace(absolute, session.cwd, `files[] entry "${source}"`);
    if (!existsSync(absolute)) throw new Error(`Source not found: ${absolute}`);
    assertNotArchive(absolute, artifactPath);
    let info;
    try {
      info = statSync(absolute);
    } catch (error) {
      throw new Error(`Source not readable: ${absolute} (${error instanceof Error ? error.message : String(error)})`);
    }
    // Keep working-directory-relative paths unchanged so the archive mirrors the tree, and
    // feed absolute paths for anything outside it.
    const relative = path.relative(session.cwd, absolute);
    let entry = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
    if (shallow && info.isDirectory()) {
      // Shallow mode only packs top-level FILES. A directory holding nothing but
      // subdirectories therefore contributes nothing, and handing bz "dir/*" makes it
      // fail with "No files to archive" — so emptiness means "no top-level file".
      let empty = false;
      try {
        empty = !readdirSync(absolute, { withFileTypes: true }).some((item) => item.isFile());
      } catch {
        empty = false;
      }
      if (empty) {
        skipped.push(entry);
        continue;
      }
      entry = path.win32.join(entry, '*');
    }
    // A name starting with "-" would be read as a switch; "./" keeps it a path.
    argv.push(entry.startsWith('-') ? `./${entry}` : entry);
    queued.push({ entry, absolute, isDirectory: info.isDirectory() });
  }
  if (sources.length > 0 && skipped.length === sources.length) {
    throw new Error(
      'No files to archive: every source was an empty directory ('
        + skipped.join(', ') + '). Pass another source, or do not set recursive:false.',
    );
  }
  const result = await session.run(argv);
  const decoded = cleanOutput(decodeWith(result.output, session.encoding), session.maxOutputChars);
  const produced = existsSync(artifactPath);
  const fresh = produced
    && (!existedBefore || beforeMtime === undefined || modifiedAt(artifactPath) !== beforeMtime);
  // bz uses exit code 1 for "warnings, but done"; append can legitimately succeed without
  // touching the mtime, so append relaxes to "exists and exit 0/1".
  const ok = isAppend
    ? produced && (result.exitCode === 0 || result.exitCode === 1)
    : (result.exitCode === 0 ? produced : result.exitCode === 1 && fresh);
  const warnings = ok ? warningsOf(decoded.text) : [];
  let size;
  if (ok) {
    try {
      size = statSync(artifactPath).size;
    } catch {
      size = undefined;
    }
  }
  // A split archive's size lives in its parts: the `.zip` alone is the last fragment, so
  // reporting only that would claim a 6 KB archive is 212 bytes.
  let parts = 1;
  let volumeNote = '';
  if (ok && volumeSize !== undefined) {
    try {
      const dir = path.dirname(artifactPath);
      const stem = path.basename(artifactPath, path.extname(artifactPath));
      const found = readdirSync(dir)
        .filter((entry) => entry.startsWith(`${stem}.z`) || entry === path.basename(artifactPath))
        .map((entry) => ({ name: entry, size: statSync(path.join(dir, entry)).size }));
      if (found.length > 1) {
        parts = found.length;
        const total = found.reduce((sum, part) => sum + part.size, 0);
        size = total;
        volumeNote = `split into ${parts} parts, ${total} bytes total`;
      }
    } catch {
      // A reported size is a convenience; never fail the create over it.
    }
  }
  const notes = [];
  if (volumeNote !== '') notes.push(volumeNote);
  if (warnings.length > 0) notes.push(`${warnings.length} warning(s) from bz.exe`);
  if (skipped.length > 0) {
    notes.push(`skipped empty director${skipped.length === 1 ? 'y' : 'ies'} ${skipped.join(', ')}`);
  }
  let verified;
  let roundtrip;
  let digest;
  if (ok && (args.verify === true || args.verify === 'roundtrip')) {
    try {
      const checkArgv = ['t', '-y'];
      if (session.password) checkArgv.push(passwordArg(session.password, session.settings.allowPassword));
      checkArgv.push(artifactPath);
      const check = await session.run(checkArgv);
      verified = check.exitCode === 0;
      if (!verified) notes.push(`created but the integrity check failed (bz exit code ${check.exitCode})`);
    } catch (error) {
      verified = false;
      notes.push(`created but the integrity check could not run (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  // The digest identifies the artifact that was produced; it is what a roundtrip or a later
  // download can be checked against.
  if (ok) {
    try {
      digest = { algorithm: 'sha256', hex: await hashFile(artifactPath, 'sha256') };
    } catch {
      digest = undefined;
    }
  }
  // Round trip: unpack into a temporary directory and compare every file that went in
  // against what came out. `bz t` proves the container is sound; only this proves the
  // content survived.
  if (ok && args.verify === 'roundtrip') {
    let tempDir;
    try {
      // Mirror how bz stores what it was given: a relative entry keeps its path, an
      // absolute one is stored under its base name.
      const before = new Map();
      for (const source of queued) {
        // A shallow entry carries a "dir/*" suffix that is not part of the stored name.
        const raw = source.entry.replace(/[\\/]\*$/, '');
        const base = (path.isAbsolute(raw) ? path.basename(raw) : raw).split(path.sep).join('/');
        if (source.isDirectory) {
          for (const [relative, meta] of await digestTree(source.absolute)) {
            // recursive:false archives only the top level, so a deeper file is legitimately
            // absent rather than missing.
            if (shallow && relative.includes('/')) continue;
            before.set(base === '' ? relative : `${base}/${relative}`, meta);
          }
        } else {
          before.set(base, {
            size: statSync(source.absolute).size,
            sha256: await hashFile(source.absolute, 'sha256'),
          });
        }
      }
      tempDir = mkdtempSync(path.join(os.tmpdir(), 'bandizip-verify-'));
      const extractArgv = ['x', '-y', '-o:' + tempDir];
      if (session.password) extractArgv.push(passwordArg(session.password, session.settings.allowPassword));
      extractArgv.push(artifactPath);
      const extracted = await session.run(extractArgv);
      if (extracted.exitCode !== 0 && extracted.exitCode !== 1) {
        roundtrip = {
          ok: false,
          checkedFiles: before.size,
          reason: `unpacking failed, so nothing could be compared (bz exit code ${extracted.exitCode})`,
        };
      } else {
        const after = await digestTree(tempDir);
        const missing = [];
        const differing = [];
        for (const [name, meta] of before) {
          const copy = after.get(name);
          if (copy === undefined) missing.push(name);
          else if (copy.size !== meta.size || copy.sha256 !== meta.sha256) differing.push(name);
        }
        roundtrip = {
          ok: missing.length === 0 && differing.length === 0,
          checkedFiles: before.size,
          ...(missing.length === 0 ? {} : { missing }),
          ...(differing.length === 0 ? {} : { differing }),
        };
        if (!roundtrip.ok) {
          notes.push(`roundtrip comparison failed (${missing.length} missing, ${differing.length} differing)`);
        }
      }
    } catch (error) {
      roundtrip = { ok: false, checkedFiles: 0, reason: error instanceof Error ? error.message : String(error) };
      notes.push(`roundtrip comparison could not run (${roundtrip.reason})`);
    } finally {
      if (tempDir !== undefined) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // A leftover temp directory must never fail the create.
        }
      }
    }
  }
  const result2 = {
    ok,
    archive: artifactPath,
    format,
    mode: effectiveMode,
    exitCode: result.exitCode,
    output: decoded.text,
    truncated: decoded.truncated,
  };
  if (size !== undefined) result2.size = size;
  if (parts > 1) result2.parts = parts;
  if (verified !== undefined) result2.verified = verified;
  if (digest !== undefined) result2.digest = digest;
  if (roundtrip !== undefined) result2.roundtrip = roundtrip;
  if (notes.length > 0) result2.note = notes.join('; ');
  return result2;
}

/** Resolve a format from the archive's own extension, refusing an unknown one. */
function requireFormatFromName(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tgz';
  const detected = FORMAT_BY_EXTENSION[path.extname(lower)];
  if (detected !== undefined && FORMATS.includes(detected)) return detected;
  throw new Error(
    `Cannot infer an archive format from "${path.basename(archivePath)}". `
      + `Pass format with one of: ${FORMATS.join(', ')}.`,
  );
}

/** Validate an explicitly requested format for a writer tool. */
function parseFormatRequest(requested) {
  if (typeof requested !== 'string') {
    throw new Error(`format must be a string, got ${JSON.stringify(requested)}.`);
  }
  const normalized = requested.replace(/^\./, '').toLowerCase();
  if (!FORMATS.includes(normalized)) {
    throw new Error(`Unsupported archive format "${requested}". Use one of: ${FORMATS.join(', ')}.`);
  }
  return normalized;
}

/**
 * `extract_archive`.
 *
 * Unchanged safety order from the old `extract` action: zip-slip, compressed-bomb ceiling,
 * symlink policy — all checked before a single byte is written. New: the `symlinks`
 * argument makes the policy a per-call decision ('reject' by default, 'skip' drops the
 * entries, 'allow' takes them anyway), and `checksum` verifies the source archive itself
 * before extracting from it.
 */
async function extractArchiveTool(session, args) {
  const archivePath = resolveTarget(session, args.archive, 'archive');
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  const destinationPath = resolveTarget(session, args.destination, 'destination');
  if (destinationPath.toLowerCase() === archivePath.toLowerCase()) {
    throw new Error(`destination must not be the archive itself: ${archivePath}`);
  }
  if (existsSync(destinationPath)) {
    let isDirectory = false;
    try {
      isDirectory = statSync(destinationPath).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new Error(`destination already exists as a file: ${destinationPath}`);
  }
  const overwriteMode = args.overwrite;
  if (!Object.hasOwn(OVERWRITE_SWITCH, overwriteMode)) {
    throw new Error(`overwrite must be one of ${Object.keys(OVERWRITE_SWITCH).join(', ')}, got ${JSON.stringify(overwriteMode)}.`);
  }
  const symlinkPolicy = args.symlinks === undefined
    ? (session.settings.rejectSymlinkEntries !== false ? 'reject' : 'allow')
    : args.symlinks;
  if (!['reject', 'skip', 'allow'].includes(symlinkPolicy)) {
    throw new Error(`symlinks must be one of reject, skip, allow; got ${JSON.stringify(args.symlinks)}.`);
  }

  // Verify the archive itself before writing anything out of it.
  const expected = parseChecksum(args.checksum);
  if (expected !== undefined) {
    const actual = await hashFile(archivePath, expected.algorithm);
    if (actual !== expected.hex) {
      return {
        ok: false,
        archive: archivePath,
        destination: destinationPath,
        extracted: 0,
        entries: [],
        conflicts: [],
        rejected: true,
        skipped: 0,
        symlinks: [],
        note: `Refusing to extract: the archive digest does not match (expected `
          + `${expected.algorithm}:${expected.hex}, got ${actual}).`,
      };
    }
  }

  const listing = await listArchive(
    session.run, archivePath, session.password, session.settings.allowPassword, session.encoding,
  );
  if (!listing.ok) {
    throw new Error(
      `bz.exe could not list ${path.basename(archivePath)} (exit code ${listing.exitCode}); nothing was extracted.\n`
        + truncateOutput(listing.text, session.maxOutputChars).text,
    );
  }
  // zip-slip check: reject the whole archive on an unsafe entry name.
  const unsafe = listing.entries.find((entry) => {
    // Check the raw (slash-normalized) name too: normalizeEntryPath strips a leading "/",
    // so an absolute entry such as "/etc/passwd" must be caught here.
    const raw = String(entry.name).replace(/\\/g, '/');
    const name = normalizeEntryPath(entry.name);
    return name.includes('../') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw);
  });
  if (unsafe) {
    return {
      ok: false,
      archive: archivePath,
      destination: destinationPath,
      extracted: 0,
      entries: [],
      conflicts: [],
      rejected: true,
      skipped: 0,
      symlinks: [],
      note: `Refusing to extract: archive contains an unsafe entry "${unsafe.name}" (path traversal or absolute path).`,
    };
  }
  // Compressed-bomb ceiling. These sizes come from the archive's own headers, so an archive
  // can understate them: this is a cheap early stop, not proof.
  const maxExtractBytes = Number(session.settings.maxExtractBytes) > 0 ? Number(session.settings.maxExtractBytes) : 0;
  if (maxExtractBytes > 0) {
    const declaredBytes = listing.entries.reduce(
      (sum, entry) => sum + (Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0), 0,
    );
    if (declaredBytes > maxExtractBytes) {
      return {
        ok: false,
        archive: archivePath,
        destination: destinationPath,
        extracted: 0,
        entries: [],
        conflicts: [],
        rejected: true,
        skipped: 0,
        symlinks: [],
        note: `Refusing to extract: entries declare ${declaredBytes} bytes, over the ${maxExtractBytes}-byte `
          + 'maxExtractBytes ceiling. Raise that setting if the archive is legitimate.',
      };
    }
  }
  // Symlink entries. Only a ZIP central directory and a tar header record the entry type,
  // so other formats are simply not covered here; that is documented rather than silently
  // assumed clean.
  const sniffed = sniffFormat(archivePath);
  const format = sniffed?.format ?? formatFromListing(listing.text) ?? 'unknown';
  const symlinkScan = symlinkPolicy === 'allow'
    ? { checked: false, symlinks: [] }
    : symlinkEntriesOf(archivePath, format);
  const symlinkNames = symlinkScan.checked ? symlinkScan.symlinks : [];
  if (symlinkPolicy === 'reject' && symlinkNames.length > 0) {
    const shown = symlinkNames.slice(0, 5).map((name) => `"${name}"`).join(', ');
    return {
      ok: false,
      archive: archivePath,
      destination: destinationPath,
      extracted: 0,
      entries: [],
      conflicts: [],
      rejected: true,
      skipped: 0,
      symlinks: symlinkNames.slice(0, 50),
      note: `Refusing to extract: archive contains symlink entries (${shown}`
        + `${symlinkNames.length > 5 ? ', …' : ''}). A symlink can redirect later writes outside the `
        + 'destination. Pass symlinks:"skip" to drop them, or "allow" only if you trust this archive.',
    };
  }

  const includeMasks = Array.isArray(args.include)
    ? args.include.filter((item) => typeof item === 'string' && item !== '')
    : [];
  const excludeMasks = Array.isArray(args.exclude)
    ? args.exclude.filter((item) => typeof item === 'string' && item !== '')
    : [];
  // A skipped symlink is expressed as an exclusion: the extraction then goes through the
  // per-entry path, which is the only one that can leave individual entries out.
  const skipSet = new Set(symlinkPolicy === 'skip' ? symlinkNames.map(normalizeEntryPath) : []);
  const matchMask = (name, mask) => compileGlob(normalizeEntryPath(mask)).test(normalizeEntryPath(name));
  const selectedFiles = listing.entries.filter((entry) => {
    if (entry.isDir) return false;
    if (skipSet.has(normalizeEntryPath(entry.name))) return false;
    if (includeMasks.length > 0 && !includeMasks.some((mask) => matchMask(entry.name, mask))) return false;
    if (excludeMasks.length > 0 && excludeMasks.some((mask) => matchMask(entry.name, mask))) return false;
    return true;
  });
  const overwriteSwitch = OVERWRITE_SWITCH[overwriteMode];
  // bz's `e` writes without directory names; `x` keeps them. Every branch below has to
  // honour this, including the per-entry one, because `e` accepts file masks as well.
  const extractCommand = args.flat === true ? 'e' : 'x';
  // Where an entry really lands: flat mode drops every directory segment. The conflict
  // snapshot, the dry run and the reported landed paths must all use this one rule, or a
  // flat extract reports zero conflicts against files it is about to overwrite.
  const landingPathOf = (name) => {
    const segments = String(name).split('/').filter(Boolean);
    return args.flat === true
      ? path.resolve(destinationPath, segments.pop() ?? String(name))
      : path.resolve(destinationPath, ...segments);
  };
  // Snapshot what already exists BEFORE extracting: after the call every selected file
  // exists, so a post-hoc scan would report the whole archive as a conflict.
  const conflicts = [];
  let existingCount = 0;
  // Two entries can share a flat landing path, so count distinct targets rather than files.
  const seenTargets = new Set();
  for (const entry of selectedFiles) {
    const target = landingPathOf(entry.name);
    if (!existsSync(target)) continue;
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    existingCount += 1;
    if (conflicts.length < 20) conflicts.push(target);
  }

  // Dry run: no writes; report would-create/overwrite/skip and the first 20 conflicts.
  if (args.dryRun === true) {
    const distinctTargets = new Set(selectedFiles.map((entry) => landingPathOf(entry.name)));
    const wouldCreate = distinctTargets.size - existingCount;
    const wouldSkip = overwriteMode === 'skip' ? existingCount : 0;
    const wouldOverwrite = overwriteMode === 'skip' ? 0 : existingCount;
    return {
      ok: true,
      archive: archivePath,
      destination: destinationPath,
      extracted: 0,
      entries: [],
      conflicts,
      rejected: false,
      skipped: wouldSkip,
      symlinks: skipSet.size === 0 ? [] : symlinkNames.slice(0, 50),
      wouldCreate,
      wouldOverwrite,
      wouldSkip,
      note: `Dry run: ${selectedFiles.length} file(s) selected. No files were written.`,
    };
  }

  let result;
  let usedOutput = '';
  if (includeMasks.length > 0 && excludeMasks.length === 0 && skipSet.size === 0) {
    // include can be handed straight to bz as backslash masks, with an explicit overwrite
    // switch so bz never waits at an interactive prompt.
    const argv = [extractCommand, `-o:${destinationPath}`, overwriteSwitch, '-y'];
    if (session.password) argv.push(passwordArg(session.password, session.settings.allowPassword));
    argv.push(archivePath);
    for (const mask of includeMasks) argv.push(normalizeEntryPath(mask).replace(/\//g, '\\'));
    result = await session.run(argv);
    usedOutput = decodeWith(result.output, session.encoding);
  } else if (excludeMasks.length > 0 || includeMasks.length > 0 || skipSet.size > 0) {
    // exclude is implemented by difference: extract selected files one by one with
    // backslash masks (with the same overwrite switch).
    const outputs = [];
    let failed;
    for (const entry of selectedFiles) {
      if (excludeMasks.some((mask) => matchMask(entry.name, mask))) continue;
      const mask = entry.name.replace(/\//g, '\\');
      const argv = [extractCommand, `-o:${destinationPath}`, overwriteSwitch, '-y'];
      if (session.password) argv.push(passwordArg(session.password, session.settings.allowPassword));
      argv.push(archivePath, mask);
      const one = await session.run(argv);
      outputs.push(decodeWith(one.output, session.encoding));
      if (one.exitCode !== 0 && failed === undefined) failed = one.exitCode;
    }
    result = { exitCode: failed ?? 0, output: Buffer.from(outputs.join('\n')) };
    usedOutput = outputs.join('\n');
  } else {
    const argv = [extractCommand, `-o:${destinationPath}`, overwriteSwitch, '-y'];
    if (session.password) argv.push(passwordArg(session.password, session.settings.allowPassword));
    argv.push(archivePath);
    result = await session.run(argv);
    usedOutput = decodeWith(result.output, session.encoding);
  }
  const decoded = cleanOutput(usedOutput, session.maxOutputChars);
  const ok = result.exitCode === 0;
  const maxEntries = 500;
  const top = [...new Set(selectedFiles.map((entry) => normalizeEntryPath(entry.name).split('/')[0]))].filter(Boolean);
  const response = {
    ok,
    archive: archivePath,
    destination: destinationPath,
    extracted: selectedFiles.length,
    entries: selectedFiles.slice(0, maxEntries).map((entry) => ({
      name: entry.name,
      size: entry.size,
      landed: landingPathOf(entry.name),
    })),
    conflicts,
    rejected: false,
    skipped: overwriteMode === 'skip' ? existingCount : 0,
    symlinks: skipSet.size === 0 ? [] : symlinkNames.slice(0, 50),
    output: decoded.text,
    truncated: decoded.truncated,
  };
  if (!ok) {
    response.note = `bz.exe exited with code ${result.exitCode}.`;
  } else if (args.flat !== true && top.length === 1
    && !selectedFiles.some((entry) => !normalizeEntryPath(entry.name).includes('/'))) {
    response.note = `Everything landed under a single top-level folder (${top[0]}); `
      + 'extract that folder\'s contents if you wanted them at the root.';
  }
  return response;
}

/**
 * `convert_archive`.
 *
 * Unchanged from the old `convert` action: unpack to a private temp directory, repack in the
 * target format, run `bz t` on the result, and only then delete the source when asked. The
 * target is now nameable through `destination` instead of always being derived from the
 * source name.
 */
async function convertArchiveTool(session, args) {
  const archivePath = resolveTarget(session, args.archive, 'archive');
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  const targetFormat = args.format === undefined
    ? requireFormatFromName(archivePath)
    : parseFormatRequest(args.format);
  const level = parseLevel(args.level);
  const newPassword = typeof args.newPassword === 'string' && args.newPassword !== '' ? args.newPassword : undefined;
  const derived = `${archivePath.replace(ARCHIVE_EXTENSION, '')}.${targetFormat}`;
  const targetPath = args.destination === undefined || args.destination === ''
    ? derived
    : resolveTarget(session, args.destination, 'destination');
  if (targetPath.toLowerCase() === archivePath.toLowerCase()) {
    throw new Error('convert target equals the source archive; choose a different format or destination.');
  }
  if (session.settings.restrictToWorkspace) assertInsideWorkspace(targetPath, session.cwd, 'convert target');
  const existedBefore = existsSync(targetPath);
  // Reuse the create overwrite gate for an existing target.
  assertCreateOverwrite(targetPath, existedBefore, args.overwrite, session.settings);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-bandizip-convert-'));
  const unpackDir = path.join(tempRoot, 'src');
  mkdirSync(unpackDir);
  try {
    const throwOnFailure = (message, code, buffer) => new Error(
      `${message} (bz exit code ${code}).\n` + cleanOutput(decodeWith(buffer, session.encoding), session.maxOutputChars).text,
    );
    const argvX = ['x', `-o:${unpackDir}`, OVERWRITE_SWITCH.overwrite, '-y'];
    if (session.password) argvX.push(passwordArg(session.password, session.settings.allowPassword));
    argvX.push(archivePath);
    const extracted = await session.run(argvX);
    if (extracted.exitCode !== 0) {
      throw throwOnFailure(`bz.exe failed to unpack ${path.basename(archivePath)}`, extracted.exitCode, extracted.output);
    }
    // bz c -fmt:<fmt> -l:<level> [-p:<pw>] -r -y <target> <files...>
    const argvC = ['c', `-fmt:${targetFormat}`, `-l:${level}`, '-r', '-y'];
    if (newPassword) argvC.push(passwordArg(newPassword, session.settings.allowPassword));
    argvC.push(targetPath, './*');
    const created = await session.run(argvC, unpackDir);
    if (!existsSync(targetPath)) {
      throw throwOnFailure('bz.exe did not create the converted archive', created.exitCode, created.output);
    }
    // The test reads the NEW archive, so it takes newPassword, not the source password.
    const testArgv = ['t', '-y'];
    if (newPassword) testArgv.push(passwordArg(newPassword, session.settings.allowPassword));
    testArgv.push(targetPath);
    const tested = await session.run(testArgv);
    if (tested.exitCode !== 0) {
      throw new Error(
        `The converted archive failed its integrity test (bz exit code ${tested.exitCode}); the target was `
          + `left in place for inspection: ${targetPath}.`,
      );
    }
    let sourceDeleted = false;
    if (args.deleteSource === true) {
      try {
        unlinkSync(archivePath);
        sourceDeleted = true;
      } catch {
        // Conversion succeeded; only deletion failed. Report honestly.
        sourceDeleted = false;
      }
    }
    const result = {
      ok: true,
      archive: archivePath,
      convertedTo: targetPath,
      format: targetFormat,
      level,
      sourceDeleted,
      size: statSync(targetPath).size,
    };
    if (args.deleteSource === true && !sourceDeleted) {
      result.note = 'The converted archive is in place, but the source could not be deleted.';
    }
    return result;
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// ------------------------------------------------------------------- tool declarations

/**
 * Every parameter is declared once here and picked per tool, so a description cannot drift
 * between tools and a tool can only expose what it actually reads. `name` is the wire name;
 * the object key is the descriptor id used below.
 */
const FIELD = {
  archive: {
    name: 'archive',
    type: 'string',
    description: 'Archive path, resolved against the session working directory when relative.',
  },
  archive2: {
    name: 'archive2',
    type: 'string',
    description: 'The second archive to compare against archive.',
  },
  path: {
    name: 'path',
    type: 'string',
    description: 'File to identify: an archive, an archive fragment, or any file. Its bytes decide the answer.',
  },
  files: {
    name: 'files',
    type: 'array',
    items: { type: 'string' },
    description:
      'Files and folders to compress, in the order they are added. Paths inside the archive keep their '
      + 'location relative to the session working directory, so "src" appears as "src/..." in the archive.',
  },
  file: {
    name: 'file',
    type: 'string',
    description: 'The single file to compress or decompress.',
  },
  destination: {
    name: 'destination',
    type: 'string',
    description:
      'Output path. extract_archive: folder to unpack into (required; created when missing). '
      + 'compress_file / decompress_file / convert_archive: the file to write; omit it to derive one.',
  },
  password: {
    name: 'password',
    type: 'string',
    description:
      'Password for reading an encrypted archive. Passed to bz.exe as a command-line switch, so it is '
      + "visible in the process list. Rejected outright when the plugin's allowPassword setting is off.",
  },
  newPassword: {
    name: 'newPassword',
    type: 'string',
    description:
      'Password for the new archive. Omit it to produce an unencrypted archive. Subject to the same '
      + 'allowPassword gate as password.',
  },
  deleteSource: {
    name: 'deleteSource',
    type: 'boolean',
    description:
      'Delete the source archive after the converted archive is in place and verified. Default false. '
      + 'Ignored on failure.',
  },
  include: {
    name: 'include',
    type: 'array',
    items: { type: 'string' },
    description:
      'Glob patterns (* and **) selecting entries. create_archive: matched against paths relative to the '
      + 'session working directory (an empty match set is an error). extract_archive: archive-internal '
      + 'masks selecting which entries to unpack.',
  },
  exclude: {
    name: 'exclude',
    type: 'array',
    items: { type: 'string' },
    description:
      'Glob patterns (* and **) excluding entries. create_archive: matched against paths relative to the '
      + 'session working directory. extract_archive: archive-internal masks; matching entries are left out '
      + 'by extracting the remaining files one by one.',
  },
  formatArchive: {
    name: 'format',
    type: 'string',
    enum: FORMATS,
    description:
      'Archive format. Omit it to infer from the archive extension; a name with no recognizable extension '
      + 'is rejected, so pass format explicitly for those. For convert_archive this is the target format.',
  },
  formatStream: {
    name: 'format',
    type: 'string',
    enum: STREAM_FORMATS,
    description:
      'Compression format: gz (deflate+gzip wrapper), xz (LZMA2, via bz.exe because node:zlib has no xz '
      + 'codec), or zstd (node:zlib, needs Node >= 22.15). decompress_file may omit it: the bytes and the '
      + 'file name decide.',
  },
  level: {
    name: 'level',
    type: 'integer',
    description:
      'Compression level from 0 (store) to 9 (maximum). Omit it for 5. A non-integer or out-of-range '
      + 'value is rejected instead of being silently adjusted. For zstd, 0 means the library default '
      + 'because zstd has no store mode.',
  },
  volumeSize: {
    name: 'volumeSize',
    type: 'string',
    description:
      'Split the output into parts of this size (bz -v:), for example "100MB" or "1440k". Bytes are also '
      + 'accepted ("104857600"). The first part keeps the requested name and the rest are numbered by bz.',
  },
  mode: {
    name: 'mode',
    type: 'string',
    enum: ['create', 'append'],
    description:
      'create writes a new archive (subject to the overwrite gate); append uses bz\'s "a" command to add to '
      + 'an existing archive without the overwrite gate. If the archive does not exist, append falls back '
      + 'to create. Default create.',
  },
  overwriteArchive: {
    name: 'overwrite',
    type: 'string',
    enum: ['overwrite', 'skip', 'rename'],
    description:
      'What to do with files that already exist at the destination. overwrite replaces them, skip leaves '
      + 'them untouched, rename keeps both by renaming the incoming file.',
  },
  overwriteGate: {
    name: 'overwrite',
    type: 'string',
    enum: ['overwrite'],
    description:
      'Pass "overwrite" to replace an existing archive at that path. Omitted or any other value, the '
      + 'call is refused; replacing also requires allowArchiveOverwrite on the plugin page.',
  },
  overwriteFile: {
    name: 'overwrite',
    type: 'boolean',
    description: 'Replace an existing output file. Default false: an existing file is never overwritten silently.',
  },
  verify: {
    name: 'verify',
    description:
      'Check the new archive before reporting success. `true` runs a full `bz t` integrity check. '
      + '`"roundtrip"` does that plus extracts the archive to a temporary folder and compares every source '
      + 'file against what came back out (size and SHA-256) — proof that what was packed is what unpacks, '
      + 'not merely that the container is intact. A failed check is reported and never deletes the archive.',
    oneOf: [{ type: 'boolean' }, { type: 'string', const: 'roundtrip' }],
  },
  flat: {
    name: 'flat',
    type: 'boolean',
    description:
      'Drop directory names and write every file directly into destination (bz\'s "e" command). '
      + 'Default false: the archive structure is kept. Two different entries called src/a.txt and '
      + 'lib/a.txt collide in flat mode, and the overwrite policy decides which one survives.',
  },
  recursive: {
    name: 'recursive',
    type: 'boolean',
    description:
      'Include subdirectories of every named folder. Default true. false archives only the top-level '
      + 'files of each folder (bz -r- plus a "dir/*" entry), and is rejected when combined with '
      + 'include or exclude, because the two selections would disagree about what a match means.',
  },
  stats: {
    name: 'stats',
    type: 'boolean',
    description:
      'Also aggregate the listing: byExtension (count and bytes per extension), topLevelDirs (entry '
      + 'count and uncompressed bytes per top-level name) and largest (the ten biggest files). Computed '
      + 'from the entries already parsed, so it costs no second bz call. Default false. The aggregates '
      + 'describe the WHOLE archive, not the current page or filter.',
  },
  dryRun: {
    name: 'dryRun',
    type: 'boolean',
    description:
      'Report what would be created, overwritten and skipped without writing anything. Entry names that '
      + 'would escape the destination are refused by the same checks a real extract runs.',
  },
  checksum: {
    name: 'checksum',
    type: 'string',
    description:
      'Expected digest of the file, as "<algorithm>:<hex>" (md5, sha1, sha256, sha512) or a bare hex digest '
      + 'whose length identifies the algorithm. check_archive compares it with the archive on disk; '
      + 'extract_archive refuses to extract when it does not match.',
  },
  filter: {
    name: 'filter',
    type: 'string',
    description:
      'Case-insensitive text to narrow the result by entry name. Plain text matches as a substring; '
      + 'a value containing * or ? is treated as a glob (* covers one path segment, ** covers any).',
  },
  limit: {
    name: 'limit',
    type: 'integer',
    description:
      'Maximum number of parsed entries to return (after offset). Omit it to return every entry. '
      + 'Use it with nextOffset to page through a large listing.',
  },
  offset: {
    name: 'offset',
    type: 'integer',
    description: 'Number of parsed entries to skip before returning. Default 0.',
  },
  encoding: {
    name: 'encoding',
    type: 'string',
    enum: ENCODINGS,
    description:
      'Output encoding when decoding bz.exe output. auto (default) tries UTF-8 then falls back to GBK; '
      + 'utf-8 and gbk force a specific decoder.',
  },
  symlinks: {
    name: 'symlinks',
    type: 'string',
    enum: ['reject', 'skip', 'allow'],
    description:
      'What to do with symbolic-link entries. reject (default, follows the rejectSymlinkEntries setting) '
      + 'refuses the whole archive; skip leaves the links out and extracts everything else; allow takes '
      + 'them as-is. Only zip/zipx (central directory) and tar (typeflag) can be inspected.',
  },
  timeoutSeconds: {
    name: 'timeoutSeconds',
    type: 'integer',
    description: 'Per-call timeout in seconds, 1-86400. Overrides the configured timeout for this call only.',
  },
};

/** Build one tool's parameter object from descriptor ids. */
function parameterSchema(ids, required = []) {
  const properties = {};
  for (const id of ids) {
    const field = FIELD[id];
    properties[field.name] = Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'name'));
  }
  return { type: 'object', additionalProperties: false, properties, required: [...required] };
}

/**
 * The host does not validate arguments against `parameters` on this path, so a parameter a
 * tool never declares would otherwise be dropped without a word. Refuse it instead: a call
 * that names the wrong tool's argument is a mistake worth reporting.
 */
function assertArguments(args, ids, required, toolName) {
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object') throw new Error(`${toolName} expects an argument object.`);
  const allowed = new Set(ids.map((id) => FIELD[id].name));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${toolName} does not take ${unknown.map((key) => `"${key}"`).join(', ')}. `
        + `It accepts: ${[...allowed].sort().join(', ')}.`,
    );
  }
  // The schema's `required` list is advisory here for the same reason: nothing upstream
  // enforces it, and a missing path argument would otherwise resolve to "<cwd>/undefined".
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    throw new Error(
      `${toolName} requires ${missing.map((key) => `"${key}"`).join(', ')}. `
        + `Required: ${required.join(', ')}.`,
    );
  }
}

/** A short human line for the call card, one renderer per answer shape. */
const RENDER = {
  list: (_args, value) => {
    const text = value ?? {};
    const parts = [
      `${text.format ?? '?'} archive, ${text.total ?? 0} entries`
        + (text.volumes?.split ? `, split into ${text.volumes.parts} parts` : ''),
      `encrypted: ${text.encrypted === true ? 'yes' : text.encrypted === false ? 'no' : 'unknown'}`,
    ];
    if (text.note !== undefined) parts.push(text.note);
    // `stats:true` computes four aggregates; showing them is the whole point of asking.
    if (typeof text.totalUncompressedBytes === 'number' && Array.isArray(text.byExtension)) {
      const top = (list, label, render) => {
        if (!Array.isArray(list) || list.length === 0) return;
        parts.push(`${label}: ${list.slice(0, 5).map(render).join(', ')}`);
      };
      parts.push(`uncompressed total: ${text.totalUncompressedBytes} bytes`);
      top(text.byExtension, 'by extension', (item) => `${item.extension}×${item.count} (${item.bytes} B)`);
      top(text.topLevelDirs, 'top level', (item) => `${item.name}×${item.entryCount}`);
      top(text.largest, 'largest', (item) => `${item.name} (${item.size} B)`);
    }
    const body = Array.isArray(text.entries) && text.entries.length > 0
      ? text.entries.map((entry) => `${entry.isDir ? 'D' : ' '} ${entry.size}\t${entry.name}`).join('\n')
      : text.output;
    return [{ type: 'text', text: [...parts, body].filter((part) => typeof part === 'string' && part !== '').join('\n\n') }];
  },
  extract: (_args, value) => {
    const text = value ?? {};
    const lines = [
      text.rejected === true
        ? 'Refused to extract.'
        : `Extracted ${text.extracted ?? 0} file(s) into ${text.destination ?? ''}`
          + (text.skipped > 0 ? `, ${text.skipped} left in place` : ''),
    ];
    if (text.note !== undefined) lines.push(text.note);
    if (text.output) lines.push(text.output);
    return [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }];
  },
  create: (_args, value) => {
    const text = value ?? {};
    const lines = [
      // `ok` decides the verb: bz can fail after printing a normal-looking banner, and
      // announcing "Created" for an archive that does not exist is the worst answer here.
      `${text.ok === false
        ? 'Failed to create'
        : (text.mode === 'append' ? 'Appended to' : 'Created')} ${text.archive ?? ''} (${text.format ?? '?'}`
        + `${typeof text.size === 'number' ? `, ${text.size} bytes` : ''})`
        + (typeof text.parts === 'number' ? `, ${text.parts} parts` : ''),
    ];
    if (text.digest && typeof text.digest.hex === 'string') lines.push(`Digest: ${text.digest.algorithm}:${text.digest.hex}`);
    if (text.roundtrip && typeof text.roundtrip === 'object') {
      const roundtrip = text.roundtrip;
      lines.push(roundtrip.ok
        ? `Roundtrip: passed (${roundtrip.checkedFiles ?? 0} files compared)`
        : `Roundtrip: failed${roundtrip.reason === undefined ? '' : ` (${roundtrip.reason})`}`);
    }
    if (text.note !== undefined) lines.push(text.note);
    if (text.output) lines.push(text.output);
    return [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }];
  },
  check: (_args, value) => {
    const text = value ?? {};
    const lines = [
      `Integrity: ${text.integrity ?? 'unknown'} (bz exit code ${text.exitCode ?? '?'})`,
    ];
    if (text.checksum) {
      lines.push(`Checksum ${text.checksum.algorithm}: ${text.checksum.matched ? 'matches' : 'MISMATCH'} `
        + `(expected ${text.checksum.expected}, got ${text.checksum.actual})`);
    }
    if (text.note !== undefined) lines.push(text.note);
    if (text.output) lines.push(text.output);
    return [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }];
  },
  detect: (_args, value) => {
    const text = value ?? {};
    return [{
      type: 'text',
      text: `${text.format ?? '?'} (${text.confidence ?? '?'})\n`
        + `encrypted: ${text.encryptedGuess === true ? 'yes' : text.encryptedGuess === false ? 'no' : 'unknown'}`
        + `\narchive: ${text.isArchive === true ? 'yes' : 'no'}`
        + (typeof text.size === 'number' ? `\nsize: ${text.size} bytes` : '')
        + (text.note === undefined ? '' : `\n${text.note}`),
    }];
  },
  diff: (_args, value) => {
    const text = value ?? {};
    const counts = text.counts ?? {};
    const lines = [
      `diff ${archiveLabel(text.archive)} -> ${archiveLabel(text.archive2)}: `
        + `${counts.added ?? 0} added, ${counts.removed ?? 0} removed, ${counts.changed ?? 0} changed`,
    ];
    const show = (label, list) => {
      if (!Array.isArray(list) || list.length === 0) return;
      lines.push(`${label}:\n${list.map((item) => `  ${item.name}`).join('\n')}`);
    };
    show('added', text.added);
    show('removed', text.removed);
    show('changed', text.changed);
    if (text.note !== undefined) lines.push(text.note);
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
  stream: (_args, value) => {
    const text = value ?? {};
    return [{
      type: 'text',
      text: `${text.format ?? ''} -> ${text.output ?? ''}\n`
        + `${text.inputBytes ?? 0} -> ${text.outputBytes ?? 0} bytes (ratio ${text.ratio ?? '?'})`
        + (text.note === undefined ? '' : `\n${text.note}`),
    }];
  },
  convert: (_args, value) => {
    const text = value ?? {};
    return [{
      type: 'text',
      text: `Converted ${archiveLabel(text.archive)} to ${text.convertedTo ?? ''} (${text.format ?? '?'}, level `
        + `${text.level ?? '?'})${text.sourceDeleted ? '; source deleted' : ''}`
        + (text.note === undefined ? '' : `\n${text.note}`),
    }];
  },
};

/**
 * The answer shape of a single-stream operation. A factory, not a constant, so the two tools
 * that use it each own their object instead of sharing one.
 */
function streamSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      output: { type: 'string' },
      format: { type: 'string' },
      inputBytes: { type: 'integer' },
      outputBytes: { type: 'integer' },
      ratio: { type: 'number' },
      note: { type: 'string' },
    },
    required: ['ok', 'output', 'format'],
  };
}

/** Output schemas, one per tool. A shared union of every field was the old defect. */
const OUTPUT = {
  list: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      format: { type: 'string' },
      encrypted: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
      volumes: {
        type: 'object',
        additionalProperties: false,
        properties: { split: { type: 'boolean' }, parts: { type: 'integer' } },
        required: ['split', 'parts'],
      },
      entries: { type: 'array', items: { type: 'object' } },
      total: { type: 'integer' },
      nextOffset: { type: 'integer' },
      totalUncompressedBytes: { type: 'integer' },
      // Only present when stats:true asked for them, so they stay out of `required`.
      byExtension: { type: 'array', items: { type: 'object' } },
      topLevelDirs: { type: 'array', items: { type: 'object' } },
      largest: { type: 'array', items: { type: 'object' } },
      note: { type: 'string' },
      output: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['ok', 'archive'],
  },
  extract: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      destination: { type: 'string' },
      extracted: { type: 'integer' },
      entries: { type: 'array', items: { type: 'object' } },
      conflicts: { type: 'array', items: { type: 'string' } },
      rejected: { type: 'boolean' },
      skipped: { type: 'integer' },
      symlinks: { type: 'array', items: { type: 'string' } },
      wouldCreate: { type: 'integer' },
      wouldOverwrite: { type: 'integer' },
      wouldSkip: { type: 'integer' },
      note: { type: 'string' },
      output: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['ok', 'archive', 'destination'],
  },
  create: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      format: { type: 'string' },
      mode: { type: 'string' },
      exitCode: { type: 'integer' },
      size: { type: 'integer' },
      parts: { type: 'integer' },
      verified: { type: 'boolean' },
      digest: {
        type: 'object',
        additionalProperties: false,
        properties: { algorithm: { type: 'string' }, hex: { type: 'string' } },
        required: ['algorithm', 'hex'],
      },
      roundtrip: {
        type: 'object',
        // `additionalProperties` does NOT inherit, so every field a failed comparison can
        // carry is declared here as well.
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          checkedFiles: { type: 'integer' },
          missing: { type: 'array', items: { type: 'string' } },
          differing: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      note: { type: 'string' },
      output: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['ok', 'archive'],
  },
  check: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      integrity: { type: 'string' },
      exitCode: { type: 'integer' },
      checksum: {
        type: 'object',
        additionalProperties: false,
        properties: {
          algorithm: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          matched: { type: 'boolean' },
        },
        required: ['algorithm', 'expected', 'actual', 'matched'],
      },
      note: { type: 'string' },
      output: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['ok', 'archive'],
  },
  // compress_file and decompress_file answer the same shape, but each gets its own object:
  // a single shared schema is how the old union grew a field nobody read.
  compress: streamSchema(),
  decompress: streamSchema(),
  detect: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { type: 'string' },
      confidence: { type: 'string' },
      encryptedGuess: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
      isArchive: { type: 'boolean' },
      size: { type: 'integer' },
      note: { type: 'string' },
    },
    required: ['format', 'confidence'],
  },
  diff: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      archive2: { type: 'string' },
      counts: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'integer' },
          removed: { type: 'integer' },
          changed: { type: 'integer' },
        },
        required: ['added', 'removed', 'changed'],
      },
      added: { type: 'array', items: { type: 'object' } },
      removed: { type: 'array', items: { type: 'object' } },
      changed: { type: 'array', items: { type: 'object' } },
      note: { type: 'string' },
    },
    required: ['ok', 'archive', 'archive2'],
  },
  convert: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      archive: { type: 'string' },
      convertedTo: { type: 'string' },
      format: { type: 'string' },
      level: { type: 'integer' },
      sourceDeleted: { type: 'boolean' },
      size: { type: 'integer' },
      note: { type: 'string' },
    },
    required: ['ok', 'archive', 'convertedTo'],
  },
};

/**
 * The nine tools, in one place: name, description, parameter scope, answer shape, and the
 * implementation each one dispatches to.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'list_archive',
    description:
      'List the entries of an archive with the local Bandizip console tool (bz.exe), and answer the two '
      + 'questions a listing alone cannot: whether the archive is encrypted and whether it is one fragment '
      + 'of a split set. Format is identified from the file bytes, not the name. Read-only. '
      + 'Encryption comes from the ZIP central directory where the format records it, from a password-less '
      + 'bz t trial where it does not (7z, RAR, LZH, CAB), and is reported as "unknown" when neither can '
      + 'answer. Volumes are detected from the sibling .z01/.z02 fragments of a ZIP. With stats:true it '
      + 'also aggregates the listing (byExtension, topLevelDirs, largest, totalUncompressedBytes) from '
      + 'the entries it already parsed, with no extra bz call.',
    params: ['archive', 'password', 'filter', 'limit', 'offset', 'encoding', 'stats', 'timeoutSeconds'],
    required: ['archive'],
    output: OUTPUT.list,
    render: RENDER.list,
    readOnly: true,
    execute: listArchiveTool,
  },
  {
    name: 'extract_archive',
    description:
      'Extract an archive into a directory with bz.exe. Before a single byte is written it checks every '
      + 'entry name for path traversal (zip-slip), sums the declared uncompressed sizes against the '
      + 'maxExtractBytes compressed-bomb ceiling, and applies the symlink policy. Any failing check rejects '
      + 'the whole archive (ok:false, rejected:true) unless symlinks:"skip" drops just those entries. '
      + 'include/exclude are archive-internal masks; dryRun reports what would happen without writing; '
      + 'checksum verifies the archive itself first; flat:true drops directory names and writes every '
      + 'file straight into destination (name collisions then follow the overwrite policy). Overwrite '
      + 'is explicit and required.',
    params: [
      'archive', 'destination', 'password', 'include', 'exclude', 'overwriteArchive',
      'encoding', 'dryRun', 'checksum', 'symlinks', 'flat', 'timeoutSeconds',
    ],
    required: ['archive', 'destination', 'overwrite'],
    output: OUTPUT.extract,
    render: RENDER.extract,
    readOnly: false,
    execute: extractArchiveTool,
  },
  {
    name: 'create_archive',
    description:
      'Create (or append to) an archive with bz.exe. Supports zip, zipx, 7z, tar, tgz, gz, xz, iso, lzh and '
      + 'self-extracting exe; rar and other formats are readable through the other tools. include/exclude '
      + 'glob the sources relative to the session working directory, volumeSize splits the output, and mode:'
      + '"append" adds to an existing archive without the overwrite gate. A successful create always returns '
      + 'the artifact digest (sha256); verify:true adds a full bz t check and verify:"roundtrip" also '
      + 'unpacks it into a temporary folder and compares every source file by size and SHA-256. The archive '
      + 'is never replaced unless allowArchiveOverwrite is on and overwrite:"overwrite" is passed. '
      + 'recursive:false packs only the top-level files of each named folder (a folder holding no '
      + 'top-level file is skipped and reported) and is refused together with include/exclude.',
    params: [
      'archive', 'files', 'formatArchive', 'level', 'include', 'exclude', 'volumeSize', 'password',
      'mode', 'overwriteGate', 'verify', 'recursive', 'timeoutSeconds',
    ],
    required: ['archive', 'files'],
    output: OUTPUT.create,
    render: RENDER.create,
    readOnly: false,
    execute: createArchiveTool,
  },
  {
    name: 'compress_file',
    description:
      'Compress one file into a gz, xz or zstd stream. gz and zstd run inside Node (node:zlib; zstd needs '
      + 'Node >= 22.15 and reports a clear error when the runtime lacks it), xz is delegated to bz.exe '
      + 'because node:zlib has no xz codec. Streaming throughout, so file size does not decide memory use. '
      + 'An existing output file is never replaced unless overwrite:true.',
    params: ['file', 'formatStream', 'destination', 'level', 'overwriteFile', 'timeoutSeconds'],
    required: ['file', 'format'],
    output: OUTPUT.compress,
    render: RENDER.stream,
    readOnly: false,
    execute: compressFileTool,
  },
  {
    name: 'decompress_file',
    description:
      'Decompress one gz, xz or zstd file back into a plain file. format may be omitted: the magic bytes '
      + 'decide, with the file name as a hint. The output name is derived by stripping .gz/.xz/.zst/.zstd '
      + 'when destination is omitted. xz goes through bz.exe (unpacked into a private temp directory, then '
      + 'copied out so no existing file is clobbered); gz and zstd stream through node:zlib.',
    params: ['file', 'formatStream', 'destination', 'overwriteFile', 'timeoutSeconds'],
    required: ['file'],
    output: OUTPUT.decompress,
    render: RENDER.stream,
    readOnly: false,
    execute: decompressFileTool,
  },
  {
    name: 'check_archive',
    description:
      'Verify an archive with `bz t`, which reads every entry\'s data — unlike `bz l`, which reads the '
      + 'central directory alone and reports a damaged archive as fine. Reports container integrity '
      + '(ok/failed) and, when checksum is given, also compares the file on disk against the expected '
      + 'digest (md5/sha1/sha256/sha512, as "<algorithm>:<hex>" or a bare hex digest). The two answers are '
      + 'kept separate because a sound container and the expected bytes are different claims. Read-only.',
    params: ['archive', 'password', 'checksum', 'timeoutSeconds'],
    required: ['archive'],
    output: OUTPUT.check,
    render: RENDER.check,
    readOnly: true,
    execute: checkArchiveTool,
  },
  {
    name: 'detect_format',
    description:
      'Identify a file from its magic bytes: zip, 7z, rar, gz/tgz, xz, bzip2, zstd, lzh, tar, iso, cab, or '
      + 'a self-extracting exe. Falls back to `bz l` and then to the file extension, and reports which of '
      + 'the three answered (confidence: magic / engine / extension). A bare extension match sets '
      + 'isArchive:false, because the bytes did not back it. encryptedGuess is filled in where the format '
      + 'can answer, and is "unknown" rather than a guess when it cannot. Read-only.',
    params: ['path', 'timeoutSeconds'],
    required: ['path'],
    output: OUTPUT.detect,
    render: RENDER.detect,
    readOnly: true,
    execute: detectFormatTool,
  },
  {
    name: 'diff_archive',
    description:
      'Compare two archives by entry name and size, reporting added, removed and changed entries (the '
      + 'first 20 of each). bz listings carry names and sizes only, so a content change that kept the size '
      + 'is reported as unchanged — the answer says so rather than implying a content comparison. '
      + 'filter narrows the result by entry name (substring, or a glob when it contains * or ?). Read-only.',
    params: ['archive', 'archive2', 'filter', 'password', 'timeoutSeconds'],
    required: ['archive', 'archive2'],
    output: OUTPUT.diff,
    render: RENDER.diff,
    readOnly: true,
    execute: diffArchiveTool,
  },
  {
    name: 'convert_archive',
    description:
      'Repack an archive into another format, level or password. Implemented by unpacking into a private '
      + 'temp directory and packing again, so it needs room for both copies. The converted archive must '
      + 'pass `bz t` before success is reported; the target is only replaced when overwrite:"overwrite" is '
      + 'passed and allowArchiveOverwrite is on. deleteSource:true removes the source only after the '
      + 'converted archive is in place and verified.',
    params: [
      'archive', 'destination', 'formatArchive', 'level', 'password', 'newPassword', 'deleteSource',
      'overwriteGate', 'timeoutSeconds',
    ],
    required: ['archive'],
    output: OUTPUT.convert,
    render: RENDER.convert,
    readOnly: false,
    execute: convertArchiveTool,
  },
];

/** Names of the registered tools, for documentation checks. */
export const TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.name);

/**
 * Register the nine bandizip tools.
 * @param ctx - tool registry, working directory, and the row's configuration source.
 * @param config - the row configuration captured at activation (schema defaults applied).
 */
export function apply(ctx, config) {
  // Volatile fields arrive as live references; flatten once here, then re-read the row
  // entry per call, because a volatile write never re-runs `apply`.
  const pluginConfig = unwrapConfig(config);
  let executable;
  let executablePath;

  /** Resolve bz.exe from the CURRENT `bzPath`, re-resolving when the setting changes. */
  function bz() {
    const configured = readRowConfig(ctx, pluginConfig).bzPath;
    if (executable === undefined || configured !== executablePath) {
      executable = resolveBzPath(configured);
      executablePath = configured;
    }
    return executable;
  }

  // `enabled: false` keeps the row's settings but publishes no tool.
  if (pluginConfig.enabled === false) return;

  /**
   * Snapshot everything one call needs. The settings are read once per call: a volatile
   * write mid-call must not make the timeout and the output cap disagree with the switches
   * handed to bz.
   */
  function makeSession(args, exec) {
    const settings = readRowConfig(ctx, pluginConfig);
    // `enabled` is a `.volatile()` field, so turning it off does not re-run `apply` and
    // cannot unregister the tools. Refuse at call time instead.
    if (settings.enabled === false) {
      throw new Error('bandizip is disabled in the plugin configuration; enable it on the plugin page to use its tools.');
    }
    const cwd = sessionDirectory(ctx, exec);
    const encoding = args?.encoding === undefined ? 'auto' : args.encoding;
    if (!ENCODINGS.includes(encoding)) {
      throw new Error(`encoding must be one of ${ENCODINGS.join(', ')}, got ${JSON.stringify(encoding)}.`);
    }
    const callTimeout = parseOptionalInt(args?.timeoutSeconds, 'timeoutSeconds', { min: 1, max: MAX_TIMEOUT_SECONDS });
    const limitSeconds = callTimeout ?? settings.timeoutSeconds;
    return {
      settings,
      cwd,
      encoding,
      maxOutputChars: settings.maxOutputChars,
      password: typeof args?.password === 'string' && args.password !== '' ? args.password : undefined,
      run: (argv, overrideCwd) => runBz(bz(), argv, {
        cwd: overrideCwd ?? cwd,
        signal: exec?.signal,
        timeoutMs: limitSeconds * 1000,
      }),
    };
  }

  for (const definition of TOOL_DEFINITIONS) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: parameterSchema(definition.params, definition.required),
      output: {
        schema: definition.output,
        render: definition.render,
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title: `${definition.name} ${archiveLabel(args?.archive ?? args?.file ?? args?.path)}`.trim(),
        // A password is a secret: the call card is rendered and persisted, so it must not
        // echo the value back (the argv itself only reaches bz).
        rawInput: args?.password === undefined && args?.newPassword === undefined
          ? args
          : {
            ...args,
            ...(args?.password === undefined ? {} : { password: '***' }),
            ...(args?.newPassword === undefined ? {} : { newPassword: '***' }),
          },
      }),
      presentResult: (args, result) => {
        const content = Array.isArray(result?.content) ? result.content : [];
        const text = content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n\n');
        return {
          card: 'generic',
          title: `${definition.name} ${archiveLabel(args?.archive ?? args?.file ?? args?.path)}`
            + (result?.isError ? ' (failed)' : ''),
          content: [{ type: 'text', text: text || `${definition.name}: no output` }],
        };
      },
      isConcurrencySafe: () => definition.readOnly === true,
      async execute(args, exec) {
        // `required` is written in wire names, `params` in descriptor ids: two tool names can
        // share a wire name (`format`, `overwrite`), so only the fields are interchangeable.
        assertArguments(args, definition.params, definition.required, definition.name);
        return definition.execute(makeSession(args, exec), args ?? {});
      },
    });
  }
}
