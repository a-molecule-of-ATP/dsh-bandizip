/**
 * Host half of the Bandizip bundle: registers one model tool that drives the
 * local Bandizip console executable (bz.exe) for create / extract / list / test
 * and the derived preview / diff / browse / convert actions.
 *
 * The tool never opens a shell: arguments are passed to bz.exe as an argv array,
 * and stdin is closed so that a missing password fails fast instead of waiting
 * for an interactive prompt.
 */
import { spawn } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';

/** Cordis plugin name. */
export const name = 'bandizip';

/**
 * Services required to register the tool, resolve the session directory, and read the
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
      + '只有 zip / zipx 能检查（读中央目录的属性位）；7z / tar 等格式不做此检查，此时该项不起作用。'),
});

const TOOL_NAME = 'bandizip';
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

const FORMATS = ['zip', 'zipx', 'exe', 'tar', 'tgz', 'lzh', 'iso', '7z', 'gz', 'xz'];
const ENCODINGS = ['auto', 'utf-8', 'gbk'];
const ACTIONS = ['create', 'extract', 'list', 'test', 'preview', 'diff', 'browse', 'convert'];

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
};

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

/** `true` when the value is an integer compression level bz accepts. */
function isLevel(value) {
  return Number.isInteger(value) && value >= 0 && value <= 9;
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
 * 保留清单表头（到分隔线为止），只留命中的条目行。
 * 必须在未截断的文本上过滤，否则超过输出上限的条目永远匹配不到。
 */
function filterListing(text, needle) {
  const lines = text.split('\n');
  const separator = lines.findIndex((line) => /^-{5,}/.test(line));
  const headEnd = separator === -1 ? Math.min(lines.length, 5) : separator + 1;
  const lower = needle.toLowerCase();
  const body = lines.slice(headEnd);
  const hits = body.filter((line) => line.toLowerCase().includes(lower));
  // 结尾的 totals 行（"180 files, 4 folders"）不是条目，命中与否都保留。
  const totals = body.filter((line) => !line.toLowerCase().includes(lower) && COUNT_LINE.test(line));
  if (hits.length === 0) {
    return [...lines.slice(0, headEnd), `(no entry matches "${needle}")`, ...totals].join('\n');
  }
  return [...lines.slice(0, headEnd), ...hits, ...totals].join('\n');
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

const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_S_IFMT = 0xf000;
const ZIP_S_IFLNK = 0xa000;

/**
 * Names of the symlink entries in a ZIP/ZIPX archive.
 *
 * `bz l` cannot answer this: its Attr column carries only the directory flag and
 * the DOS archive bit, so a symlink entry prints exactly like a regular file. The
 * Unix mode does survive in the central directory (high 16 bits of the external
 * attributes), which is the one place the entry type is recorded.
 *
 * Returns `{ checked: false, reason }` when the file is not a ZIP, is ZIP64, or is
 * malformed — callers must not read "could not check" as "clean".
 *
 * @param filePath - archive on disk.
 */
function zipSymlinkEntries(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    return { checked: false, reason: `cannot read archive: ${error instanceof Error ? error.message : String(error)}` };
  }
  // End of central directory: 22 bytes plus up to 64 KiB of trailing comment.
  const floor = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return { checked: false, reason: 'not a zip archive (no end-of-central-directory record)' };

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    return { checked: false, reason: 'zip64 central directory is not scanned' };
  }

  const symlinks = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== ZIP_SIG_CENTRAL) {
      return { checked: false, reason: `central directory malformed at entry ${n + 1}` };
    }
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const externalAttributes = buffer.readUInt32LE(p + 38);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    if (((externalAttributes >>> 16) & ZIP_S_IFMT) === ZIP_S_IFLNK) symlinks.push(name);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return { checked: true, symlinks, entryCount: count };
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
 * outside [min, max]. Used for `limit` / `offset` / `depth` / `timeoutSeconds`.
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

/** 直接向压缩包要条目数：解压后的统计不能把目标目录里原有的文件算进来。 */
async function listEntryCount(run, archivePath, password, allowPassword, encoding) {
  try {
    const argv = ['l', '-y'];
    if (password) argv.push(passwordArg(password, allowPassword));
    argv.push(archivePath);
    const result = await run(argv);
    if (result.exitCode !== 0) return undefined;
    return countsFromListing(normalizeOutput(decodeWith(result.output, encoding)));
  } catch {
    return undefined;
  }
}

/**
 * List an archive once, returning the normalized full (UNTRUNCATED) text plus
 * the parsed entry records. Every structured feature (limit/offset, preview,
 * diff, browse, dryRun, extract manifest) builds on this function.
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

/** Count regular files under a directory, bounded so a huge tree cannot stall the tool. */
function countFiles(root, limit = 20000) {
  let files = 0;
  let folders = 0;
  const stack = [root];
  while (stack.length > 0 && files + folders < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        folders += 1;
        stack.push(path.join(dir, entry.name));
      } else {
        files += 1;
      }
    }
  }
  return { files, folders };
}

function detectFormat(archivePath, requested) {
  if (requested) {
    const normalized = requested.replace(/^\./, '').toLowerCase();
    if (!FORMATS.includes(normalized)) {
      throw new Error(`Unsupported archive format "${requested}". Use one of: ${FORMATS.join(', ')}.`);
    }
    return normalized;
  }
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tgz';
  const detected = FORMAT_BY_EXTENSION[path.extname(lower)];
  if (detected) return detected;
  // No silent guess: the caller names a format, so the result is never a format
  // nobody asked for. The error text says exactly what to pass.
  throw new Error(
    `Cannot infer an archive format from "${path.basename(archivePath)}". `
      + `Pass format with one of: ${FORMATS.join(', ')}.`,
  );
}

/** Resolve the "." stem of an archive name, with the same suffix rules extract uses. */
function archiveStem(archivePath) {
  const baseName = path.basename(archivePath);
  const stem = baseName.replace(ARCHIVE_EXTENSION, '');
  return stem === baseName || stem === '' ? `${baseName} extracted` : stem;
}

/** Aggregate files by their extension (lowercase, including the dot; "<none>" for none). */
function byExtension(entries) {
  const counts = {};
  for (const entry of entries) {
    if (entry.isDir) continue;
    const base = entry.name.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : '<none>';
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([extension, count]) => ({ extension, count }));
}

/** Guess whether an entry is a nested archive by its extension. */
function looksLikeArchive(name) {
  return ARCHIVE_EXTENSION.test(name);
}

/**
 * Register the bandizip tool.
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

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Compress, extract, inspect, and verify archives with the local Bandizip console tool (bz.exe). '
      + 'Supports zip, zipx, 7z, tar, tgz, gz, xz, iso, lzh, and self-extracting exe; '
      + 'reading rar and other formats is supported by extraction and listing. '
      + 'Relative paths resolve against the session working directory. '
      + 'Actions: create (compress files/folders, with optional append mode and glob include), '
      + 'extract (unpack into a directory, with include/exclude masks, dry-run, and pre-extraction guards: '
      + 'zip-slip, compressed-bomb ceiling and symlink entries), '
      + 'list (show contents, with pagination), test (verify integrity and passwords), '
      + 'preview (inspect contents without extracting, with size/extension statistics), '
      + 'diff (compare two archives by entry size), browse (tree-browser of one folder level), '
      + 'convert (repack an archive into another format, level or password). '
      + 'The tool is non-interactive: supply password for protected archives (unless the plugin '
      + 'disables passwords). Every behaviour is decided per call - level (default 5), recursive '
      + '(default true), overwrite (default overwrite), flat (default false), mode (default create), '
      + 'encoding (default auto) and destination (default: a folder beside the archive) - so state '
      + 'each one when it matters. A per-call timeoutSeconds overrides the configured timeout. '
      + 'create refuses to replace an existing archive unless allowArchiveOverwrite is on AND '
      + 'overwrite:"overwrite" is passed explicitly; convert uses the same gate for its target.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'Operation to perform. create / extract / list / test are the basic actions; '
            + 'preview / diff / browse / convert are derived inspections and repacking.',
        },
        archive: {
          type: 'string',
          description:
            'Archive path. The archive to read for extract/list/test/preview/browse/convert and for '
            + 'diff (first archive), or the archive to write for create.',
        },
        archive2: {
          type: 'string',
          description: 'diff only: the second archive to compare against archive.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'create only: files and folders to compress, in the order they are added. '
            + 'Paths inside the archive keep their location relative to the session working directory, '
            + 'so a working-directory-relative path such as "src" appears as "src/..." in the archive.',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description:
            'create: glob patterns (* and **) matched against paths relative to the session working '
            + 'directory; only matching files/folders are added, and an empty match set is an error. '
            + 'extract: archive-internal masks (* and **) selecting which entries to unpack.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description:
            'extract only: archive-internal masks (* and **); matching entries are excluded by listing '
            + 'the archive and extracting the remaining files one by one.',
        },
        destination: {
          type: 'string',
          description:
            'extract only: folder to unpack into, created when missing. '
            + 'Omit it to unpack beside the archive, into a folder named after it.',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description:
            'create and convert: archive format. Omit it to infer from the archive extension; a name '
            + 'with no recognizable extension is rejected, so pass format explicitly for those. '
            + 'For convert this is the target format.',
        },
        level: {
          type: 'integer',
          description:
            'create and convert: compression level from 0 (store) to 9 (maximum). Omit it for 5. '
            + 'A non-integer or out-of-range value is rejected instead of being silently adjusted.',
        },
        password: {
          type: 'string',
          description:
            'Password for creating, reading, or converting an encrypted archive. '
            + 'For convert this is the password used to read the source. '
            + 'Passed to bz.exe as a command-line switch, so it is visible in the process list. '
            + "Rejected outright when the plugin's allowPassword setting is off.",
        },
        newPassword: {
          type: 'string',
          description:
            'convert only: password for the new archive (write). Omit it to produce an unencrypted '
            + 'archive. Subject to the same allowPassword gate as password.',
        },
        deleteSource: {
          type: 'boolean',
          description:
            'convert only: delete the source archive after the converted archive is in place and '
            + 'verified. Default false. Ignored on failure.',
        },
        mode: {
          type: 'string',
          enum: ['create', 'append'],
          description:
            'create only: create writes a new archive (subject to the overwrite gate); append uses '
            + 'bz\'s "a" command to add to an existing archive without the overwrite gate. If the '
            + 'archive does not exist, append falls back to create. Default create.',
        },
        volumeSize: {
          type: 'string',
          description: 'create / append only: split the output into parts of this size (bz -v:), '
            + 'for example "100MB" or "1440k". Bytes are also accepted ("104857600"). '
            + 'The first part keeps the requested name and the rest are numbered by bz.',
        },
        overwrite: {
          type: 'string',
          enum: ['overwrite', 'skip', 'rename'],
          description:
            'extract: what to do with existing files. Omit it for overwrite. '
            + 'overwrite replaces them, skip leaves them untouched, rename keeps both by renaming '
            + 'the incoming file. '
            + 'create and convert: this argument only gates replacing an existing archive. Pass '
            + 'overwrite:"overwrite" to replace it; create/convert fail otherwise.',
        },
        recursive: {
          type: 'boolean',
          description:
            'create only: include subdirectories of every folder. Omit it to recurse (the default).',
        },
        flat: {
          type: 'boolean',
          description:
            'extract only: drop directory names and write every file directly into destination. '
            + 'Omit it to keep the archive structure (the default).',
        },
        verify: {
          type: 'boolean',
          description:
            'create only: run a full integrity check on the new archive before reporting success. '
            + 'Costs one extra bz round trip; a failed check is reported but does not delete the file.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'extract only: report what would be created, overwritten and skipped without writing anything. '
            + 'Entry names that would escape the destination are refused by the same check a real extract runs.',
        },
        filter: {
          type: 'string',
          description: 'list only: case-insensitive text that a listing line must contain to be returned.',
        },
        limit: {
          type: 'integer',
          description:
            'list only: maximum number of parsed entries to return (after offset). Omit it to return '
            + 'all entries up to the output cap. Use with nextOffset to page through a large list.',
        },
        offset: {
          type: 'integer',
          description: 'list only: number of parsed entries to skip before returning. Default 0.',
        },
        encoding: {
          type: 'string',
          enum: ENCODINGS,
          description:
            'Output encoding for every action that decodes bz.exe output. auto (default) tries UTF-8 then falls back to GBK; '
            + 'utf-8 and gbk force a specific decoder.',
        },
        timeoutSeconds: {
          type: 'integer',
          description:
            'Per-call timeout in seconds, 1-86400. Overrides the configured timeout for this call only.',
        },
        path: {
          type: 'string',
          description:
            'browse only: archive-internal prefix (folder path) to browse. Omit it (or use "") for the root. '
            + 'Forward or back slashes are both accepted; separators in the response are forward slashes.',
        },
        depth: {
          type: 'integer',
          description:
            'browse only: how many path segments below path to treat as immediate children. Default 1 '
            + '(one level). Higher values group deeper paths into the current level.',
        },
      },
      required: ['action', 'archive'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          archive: { type: 'string' },
          archive2: { type: 'string' },
          destination: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          summary: { type: 'string' },
          output: { type: 'string' },
          truncated: { type: 'boolean' },
          files: { type: 'integer' },
          folders: { type: 'integer' },
          size: { type: 'integer' },
          total: { type: 'integer' },
          nextOffset: { type: 'integer' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          path: { type: 'string' },
          browseFiles: { type: 'array' },
          entries: { type: 'array' },
          entryCount: { type: 'integer' },
          entriesTruncated: { type: 'boolean' },
          byExtension: { type: 'array' },
          topLevelDirs: { type: 'array' },
          largest: { type: 'array' },
          totalUncompressedBytes: { type: 'integer' },
          added: { type: 'array' },
          removed: { type: 'array' },
          changed: { type: 'array' },
          note: { type: 'string' },
          dirs: { type: 'array' },
          nestedArchives: { type: 'array' },
          mode: { type: 'string' },
          convertedTo: { type: 'string' },
          sourceDeleted: { type: 'boolean' },
          wouldCreate: { type: 'integer' },
          wouldOverwrite: { type: 'integer' },
          wouldSkip: { type: 'integer' },
          conflicts: { type: 'array' },
          rejected: { type: 'boolean' },
          singleTopLevelDir: { type: 'string' },
          landedFiles: { type: 'array' },
        },
        required: ['action', 'archive', 'ok', 'exitCode', 'summary', 'output'],
      },
      render: (_args, value) => {
        const text = value && typeof value === 'object' ? value : {};
        const body = [text.summary, text.output].filter((part) => typeof part === 'string' && part !== '').join('\n\n');
        return [{ type: 'text', text: body || 'bandizip: no output' }];
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `bandizip ${args?.action ?? ''} ${archiveLabel(args?.archive)}`.trim(),
      // A password is a secret: the call card is rendered and persisted, so it
      // must not echo the value back (the argv itself only reaches bz).
      rawInput: args?.password === undefined && args?.newPassword === undefined
        ? args
        : { ...args, ...(args?.password === undefined ? {} : { password: '***' }), ...(args?.newPassword === undefined ? {} : { newPassword: '***' }) },
    }),
    presentResult: (args, result) => {
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('\n\n');
      return {
        card: 'generic',
        title: `bandizip ${args?.action ?? ''} ${archiveLabel(args?.archive)}`
          + (result?.isError ? ' (failed)' : ''),
        content: [{ type: 'text', text: text || 'bandizip: no output' }],
      };
    },
    isConcurrencySafe: (args) => ['list', 'test', 'preview', 'diff', 'browse'].includes(args?.action),
    async execute(args, exec) {
      // `enabled` is a `.volatile()` field, so turning it off does not re-run
      // `apply` and cannot unregister this tool. Refuse at call time instead, so
      // the switch still controls behaviour without a reload.
      if (readRowConfig(ctx, pluginConfig).enabled === false) {
        throw new Error('bandizip is disabled in the plugin configuration; enable it on the plugin page to use this tool.');
      }
      const action = args?.action;
      if (!ACTIONS.includes(action)) {
        throw new Error(`Unsupported action "${String(action)}". Use ${ACTIONS.join(', ')}.`);
      }
      const cwd = sessionDirectory(ctx, exec);
      // One snapshot per call: a volatile write mid-call cannot make the timeout and the
      // output cap disagree with the switches passed to bz.
      const settings = readRowConfig(ctx, pluginConfig);
      const archivePath = path.resolve(cwd, String(args.archive));
      if (settings.restrictToWorkspace) assertInsideWorkspace(archivePath, cwd, 'archive');
      const password = typeof args.password === 'string' && args.password !== '' ? args.password : undefined;
      const maxOutputChars = settings.maxOutputChars;
      // Item 1: per-call timeoutSeconds overrides the configured value, validated 1..86400.
      const callTimeout = parseOptionalInt(args.timeoutSeconds, 'timeoutSeconds', { min: 1, max: MAX_TIMEOUT_SECONDS });
      const effectiveTimeoutSeconds = callTimeout ?? settings.timeoutSeconds;
      const encoding = args.encoding === undefined ? 'auto' : args.encoding;
      if (!ENCODINGS.includes(encoding)) {
        throw new Error(`encoding must be one of ${ENCODINGS.join(', ')}, got ${JSON.stringify(encoding)}.`);
      }
      const run = (argv, overrideCwd) => runBz(bz(), argv, {
        cwd: overrideCwd ?? cwd,
        signal: exec.signal,
        timeoutMs: effectiveTimeoutSeconds * 1000,
      });

      // ---------------------------------------------------------------- list / test
      if (action === 'list' || action === 'test') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        if (action === 'test') {
          // `t` is the only bz command that verifies entry data; `l` reads the
          // central directory alone and reports a damaged archive as fine, so the
          // two actions must not share an implementation.
          const testArgv = ['t', '-y'];
          if (password) testArgv.push(passwordArg(password, settings.allowPassword));
          testArgv.push(archivePath);
          const tested = await run(testArgv);
          const testedOut = cleanOutput(decode(tested.output), maxOutputChars);
          const testOk = tested.exitCode === 0;
          return {
            action,
            archive: archivePath,
            ok: testOk,
            exitCode: tested.exitCode,
            summary: testOk
              ? `Archive ${path.basename(archivePath)} passed the integrity test`
              : `Integrity test FAILED for ${path.basename(archivePath)} (bz.exe exited with code ${tested.exitCode})`,
            output: testedOut.text,
            truncated: testedOut.truncated,
          };
        }
        const listing = await listArchive(run, archivePath, password, settings.allowPassword, encoding);
        const decoded = truncateOutput(listing.text, maxOutputChars);
        const ok = listing.ok;
        let summary = ok
          ? `Listed ${path.basename(archivePath)}`
            + (listing.counts ? ` (${listing.counts.files} files, ${listing.counts.folders} folders)` : '')
          : `bz.exe exited with code ${listing.exitCode}`;
        const result = {
          action,
          archive: archivePath,
          ok,
          exitCode: listing.exitCode,
          summary,
          output: decoded.text,
          truncated: decoded.truncated,
          ...(listing.counts ?? {}),
        };
        if (action === 'list') {
          // Item 2: limit/offset pagination. Slice the PARSED entries (from the
          // untruncated text), then report total and the next page's offset.
          const offset = parseOptionalInt(args.offset, 'offset', { min: 0 }) ?? 0;
          const limit = parseOptionalInt(args.limit, 'limit', { min: 1 });
          const filtered = typeof args.filter === 'string' && args.filter !== ''
            ? listing.text.split('\n').filter((line) => line.toLowerCase().includes(args.filter.toLowerCase())).join('\n')
            : listing.text;
          const sourceEntries = typeof args.filter === 'string' && args.filter !== ''
            ? parseListing(filtered)
            : listing.entries;
          const total = sourceEntries.length;
          const page = sourceEntries.slice(offset, limit === undefined ? undefined : offset + limit);
          result.output = truncateOutput(page.map((e) => `${e.isDir ? 'D' : ' '} ${e.size}\t${e.name}`).join('\n'), maxOutputChars).text;
          result.total = total;
          result.offset = offset;
          if (limit !== undefined) {
            result.limit = limit;
            // `nextOffset` is declared as an integer, so the last page omits it
            // rather than sending `null` — which the output validator would reject.
            if (offset + page.length < total) result.nextOffset = offset + page.length;
          }
          if (page.length !== sourceEntries.length || limit !== undefined) {
            result.summary += `; page ${offset + 1}-${offset + page.length} of ${total} entries`;
          }
          return result;
        }
        return result;
      }

      // ---------------------------------------------------------------- preview
      if (action === 'preview') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        const listing = await listArchive(run, archivePath, password, settings.allowPassword, encoding);
        if (!listing.ok) {
          return {
            action, archive: archivePath, ok: false, exitCode: listing.exitCode,
            summary: `bz.exe exited with code ${listing.exitCode}`, output: listing.text, truncated: false,
          };
        }
        // Item 6: topLevelDirs (entry count + uncompressed size), byExtension,
        // largest 10, and total uncompressed bytes - all from the untruncated listing.
        const files = listing.entries.filter((e) => !e.isDir);
        const topMap = new Map();
        for (const entry of listing.entries) {
          const top = entry.name.split('/')[0];
          if (!top) continue;
          const current = topMap.get(top) ?? { name: top, entryCount: 0, uncompressedBytes: 0 };
          current.entryCount += 1;
          current.uncompressedBytes += entry.size;
          topMap.set(top, current);
        }
        const topLevelDirs = [...topMap.values()].sort((a, b) => b.entryCount - a.entryCount || a.name.localeCompare(b.name));
        const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((e) => ({ name: e.name, size: e.size }));
        const totalUncompressedBytes = files.reduce((sum, e) => sum + e.size, 0);
        const decoded = truncateOutput(listing.text, maxOutputChars);
        return {
          action, archive: archivePath, ok: true, exitCode: 0,
          summary: `Previewed ${path.basename(archivePath)} (${files.length} files, ${listing.counts?.folders ?? 0} folders, ${totalUncompressedBytes} bytes uncompressed)`,
          output: decoded.text, truncated: decoded.truncated,
          files: files.length, folders: listing.counts?.folders ?? 0,
          // `entries` is the entry LIST elsewhere; a preview reports only its size.
          entryCount: listing.entries.length, byExtension: byExtension(listing.entries),
          topLevelDirs, largest, totalUncompressedBytes,
        };
      }

      // ---------------------------------------------------------------- diff
      if (action === 'diff') {
        if (!args.archive2) throw new Error('diff requires archive2: the second archive to compare.');
        const archive2 = path.resolve(cwd, String(args.archive2));
        if (settings.restrictToWorkspace) assertInsideWorkspace(archive2, cwd, 'archive2');
        if (!existsSync(archive2)) throw new Error(`Archive not found: ${archive2}`);
        const [left, right] = await Promise.all([
          listArchive(run, archivePath, password, settings.allowPassword, encoding),
          listArchive(run, archive2, password, settings.allowPassword, encoding),
        ]);
        if (!left.ok || !right.ok) {
          throw new Error(`diff failed: ${path.basename(archivePath)} exited ${left.exitCode}, ${path.basename(archive2)} exited ${right.exitCode}.`);
        }
        // Item 7: compare by (name, size); only name+size are available in bz's listing.
        const keyOf = (e) => `${e.isDir ? 'D:' : 'F:'}${e.name}`;
        const leftMap = new Map(left.entries.map((e) => [keyOf(e), e]));
        const rightMap = new Map(right.entries.map((e) => [keyOf(e), e]));
        const added = right.entries.filter((e) => !leftMap.has(keyOf(e))).map((e) => ({ name: e.name, size: e.size }));
        const removed = left.entries.filter((e) => !rightMap.has(keyOf(e))).map((e) => ({ name: e.name, size: e.size }));
        const changed = left.entries
          .filter((e) => {
            const other = rightMap.get(keyOf(e));
            return other && other.size !== e.size;
          })
          .map((e) => ({ name: e.name, from: e.size, to: rightMap.get(keyOf(e)).size }));
        const detail = (arr) => arr.slice(0, 20);
        const note = '大小相同的内容改动检测不到：bz 清单只提供条目名与大小，仅按 size 判定 changed，内容变化但大小相同的条目无法显示。';
        const line = (label, arr) => `${label} ${arr.length} 条${arr.length > 20 ? '（仅前 20 条）' : ''}`;
        return {
          action, archive: archivePath, archive2, ok: true, exitCode: 0,
          summary: `diff ${path.basename(archivePath)} -> ${path.basename(archive2)}: ${line('added', added)}, ${line('removed', removed)}, ${line('changed', changed)}. ${note}`,
          output: '', truncated: false, note,
          added: detail(added), removed: detail(removed), changed: detail(changed),
        };
      }

      // ---------------------------------------------------------------- browse
      if (action === 'browse') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        const depth = parseOptionalInt(args.depth, 'depth', { min: 1, max: 100 }) ?? 1;
        const prefix = normalizeEntryPath(args.path ?? '');
        const listing = await listArchive(run, archivePath, password, settings.allowPassword, encoding);
        if (!listing.ok) {
          return {
            action, archive: archivePath, ok: false, exitCode: listing.exitCode,
            summary: `bz.exe exited with code ${listing.exitCode}`, output: listing.text, truncated: false,
          };
        }
        // Item 8: group entries under `path` into immediate children. dirs carry
        // aggregated fileCount + size; files carry their own size. All names use "/".
        const base = prefix === '' ? '' : `${prefix.replace(/\/$/, '')}/`;
        const children = listing.entries.filter((e) => {
          const name = normalizeEntryPath(e.name);
          return base === '' ? true : name.startsWith(base) && name !== base.slice(0, -1);
        });
        const childMap = new Map();
        for (const entry of children) {
          const rest = base === '' ? entry.name : entry.name.slice(base.length);
          if (!rest) continue;
          const segments = rest.split('/').filter(Boolean);
          const name = segments.slice(0, depth).join('/');
          if (!name) continue;
          const isDir = segments.length > depth || entry.isDir;
          const current = childMap.get(name) ?? { name, isDir, fileCount: 0, size: 0 };
          if (!entry.isDir) current.fileCount += 1;
          current.size += entry.size;
          childMap.set(name, current);
        }
        const dirs = [];
        const files = [];
        for (const entry of childMap.values()) {
          if (entry.isDir) dirs.push({ name: entry.name, fileCount: entry.fileCount, size: entry.size });
          else files.push({ name: entry.name, size: entry.size });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
        const decoded = truncateOutput(listing.text, maxOutputChars);
        return {
          action, archive: archivePath, ok: true, exitCode: 0,
          summary: `Browsed ${prefix || '/'}: ${dirs.length} dirs, ${files.length} files`,
          output: decoded.text, truncated: decoded.truncated,
          path: prefix, dirs, browseFiles: files,
        };
      }

      // ---------------------------------------------------------------- convert
      if (action === 'convert') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        const targetFormat = detectFormat(archivePath, typeof args.format === 'string' ? args.format : undefined);
        const level = parseLevel(args.level);
        const newPassword = typeof args.newPassword === 'string' && args.newPassword !== '' ? args.newPassword : undefined;
        const targetPath = path.resolve(cwd, archivePath.replace(ARCHIVE_EXTENSION, '') + `.${targetFormat}`);
        if (targetPath === archivePath) throw new Error('convert target equals the source archive; choose a different format or name.');
        if (settings.restrictToWorkspace) assertInsideWorkspace(targetPath, cwd, 'convert target');
        const existedBefore = existsSync(targetPath);
        // Item 9: reuse the create overwrite gate for an existing target.
        assertCreateOverwrite(targetPath, existedBefore, args.overwrite, settings);
        // Extract the whole source into a fresh temp dir (no interaction, overwrite all).
        const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-bandizip-convert-'));
        const unpackDir = path.join(tempRoot, 'src');
        mkdirSync(unpackDir);
        try {
          const argvX = ['x', `-o:${unpackDir}`, OVERWRITE_SWITCH.overwrite, '-y'];
          if (password) argvX.push(passwordArg(password, settings.allowPassword));
          argvX.push(archivePath);
          const extracted = await run(argvX);
          if (extracted.exitCode !== 0) {
            return {
              action, archive: archivePath, ok: false, exitCode: extracted.exitCode,
              summary: `bz.exe failed to unpack source with code ${extracted.exitCode}`, output: cleanOutput(decodeWith(extracted.output, encoding), maxOutputChars).text, truncated: false,
            };
          }
          // bz c -fmt:<fmt> -l:<level> [-p:<pw>] -r -y <target> <files...>
          const argvC = ['c', `-fmt:${targetFormat}`, `-l:${level}`, '-r', '-y'];
          if (newPassword) argvC.push(passwordArg(newPassword, settings.allowPassword));
          argvC.push(targetPath, './*');
          const created = await run(argvC, unpackDir);
          if (!existsSync(targetPath)) {
            return {
              action, archive: archivePath, ok: false, exitCode: created.exitCode,
              summary: 'bz.exe did not create the converted archive', output: cleanOutput(decodeWith(created.output, encoding), maxOutputChars).text, truncated: false,
            };
          }
          // t 校验（读密码是源包的 password 还是新包？校验的是新包，用 newPassword）
          const testArgv = ['t', '-y'];
          if (newPassword) testArgv.push(passwordArg(newPassword, settings.allowPassword));
          testArgv.push(targetPath);
          const tested = await run(testArgv);
          if (tested.exitCode !== 0) {
            return {
              action, archive: archivePath, ok: false, exitCode: tested.exitCode,
              summary: `Converted archive failed integrity test (code ${tested.exitCode}); target left in place: ${targetPath}`,
              output: cleanOutput(decodeWith(tested.output, encoding), maxOutputChars).text, truncated: false,
            };
          }
          let sourceDeleted = false;
          if (args.deleteSource === true) {
            try {
              unlinkSync(archivePath);
              sourceDeleted = true;
            } catch (error) {
              // Conversion succeeded; only deletion failed. Report honestly.
              sourceDeleted = false;
            }
          }
          return {
            action, archive: archivePath, ok: true, exitCode: 0,
            summary: `Converted ${path.basename(archivePath)} to ${path.basename(targetPath)} (${targetFormat}, level ${level})${newPassword ? ' [encrypted]' : ''}${sourceDeleted ? '; source deleted' : ''}`,
            output: '', truncated: false, convertedTo: targetPath, mode: targetFormat,
            size: statSync(targetPath).size, sourceDeleted,
          };
        } finally {
          try {
            rmSync(tempRoot, { recursive: true, force: true });
          } catch {
            // best effort cleanup
          }
        }
      }

      // ---------------------------------------------------------------- create
      if (action === 'create') {
        const mode = args.mode === 'append' ? 'append' : 'create';
        const format = detectFormat(
          archivePath,
          typeof args.format === 'string' ? args.format : undefined,
        );
        const artifactPath = ARCHIVE_EXTENSION.test(path.basename(archivePath))
          ? archivePath
          : `${archivePath}.${format}`;
        const existedBefore = existsSync(artifactPath);
        // Item 5: append reuses bz's `a` command and skips the overwrite gate; fall back
        // to create when the archive does not exist yet.
        const effectiveMode = mode === 'append' && existedBefore ? 'append' : 'create';
        let sources = Array.isArray(args.files) ? args.files.filter((item) => typeof item === 'string') : [];
        // Item 4: include globs select from the given sources relative to the session cwd.
        if (Array.isArray(args.include) && args.include.length > 0) {
          const patterns = args.include.filter((item) => typeof item === 'string' && item !== '');
          const regexes = patterns.map(compileGlob);
          const expanded = [];
          // Patterns are relative to the session working directory. Walk cwd so
          // each candidate path is tested as written by the caller, and only
          // descend into the directories the caller named as sources.
          const sourceDirs = sources.map((source) => path.resolve(cwd, source));
          // A directory is searchable when it is one of the named sources or lies
          // inside one. Descend fully inside named sources; elsewhere walk only the
          // path down to a named source so relPaths stay relative to cwd.
          const searchable = (dir) => sourceDirs.some((s) => {
            const rel = path.relative(s, dir);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          });
          const ancestorOfSource = (dir) => sourceDirs.some((s) => {
            const rel = path.relative(dir, s);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          });
          const visitCwd = (dir) => {
            let entries;
            try {
              entries = readdirSync(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              const abs = path.join(dir, entry.name);
              const relPath = path.relative(cwd, abs).split(path.sep).join('/');
              if (settings.restrictToWorkspace) assertInsideWorkspace(abs, cwd, 'include match');
              if (entry.isDirectory()) {
                if (searchable(abs) || ancestorOfSource(abs)) visitCwd(abs);
              } else if (searchable(dir) && regexes.some((re) => re.test(relPath))) {
                expanded.push(abs);
              }
            }
          };
          visitCwd(cwd);
          sources = [...new Set(expanded)];
          if (sources.length === 0) {
            throw new Error(`include matched no files (patterns: ${patterns.join(', ')}). Check the patterns; they are relative to the session working directory.`);
          }
        }
        if (sources.length === 0) throw new Error('create requires files or an include pattern that matches files.');
        if (effectiveMode === 'create') {
          assertCreateOverwrite(artifactPath, existedBefore, args.overwrite, settings);
        }
        const beforeMtime = existedBefore ? modifiedAt(artifactPath) : undefined;
        const level = parseLevel(args.level);
        const isAppend = effectiveMode === 'append';
        const argv = [isAppend ? 'a' : 'c'];
        if (!isAppend) argv.push(`-fmt:${format}`);
        argv.push(`-l:${level}`);
        // A volume size splits the output into parts; only `create` and `append`
        // take it (bz ignores it for extraction).
        const volumeSize = parseVolumeSize(args.volumeSize);
        if (volumeSize !== undefined) argv.push(`-v:${volumeSize}`);
        argv.push('-y');
        // `-r-` alone does NOT stop a directory that is named explicitly from being
        // walked: bz's recursion switch only constrains wildcard expansion.
        const shallow = args.recursive === false;
        argv.push(shallow ? '-r-' : '-r');
        if (password) argv.push(passwordArg(password, settings.allowPassword));
        argv.push(artifactPath);
        const skipped = [];
        for (const source of sources) {
          const absolute = path.resolve(cwd, source);
          if (settings.restrictToWorkspace) assertInsideWorkspace(absolute, cwd, `files[] entry "${source}"`);
          if (!existsSync(absolute)) throw new Error(`Source not found: ${absolute}`);
          assertNotArchive(absolute, artifactPath);
          let info;
          try {
            info = statSync(absolute);
          } catch (error) {
            throw new Error(`Source not readable: ${absolute} (${error instanceof Error ? error.message : String(error)})`);
          }
          // Keep working-directory-relative paths unchanged so the archive mirrors the tree,
          // and feed absolute paths for anything outside it.
          const relative = path.relative(cwd, absolute);
          let entry = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
          if (shallow && info.isDirectory()) {
            let empty = false;
            try {
              empty = readdirSync(absolute).length === 0;
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
        }
        if (sources.length > 0 && skipped.length === sources.length) {
          throw new Error(
            'No files to archive: every source was an empty directory ('
            + skipped.join(', ') + '). Pass another source or recursive:true.',
          );
        }
        const result = await run(argv);
        const decoded = cleanOutput(decodeWith(result.output, encoding), maxOutputChars);
        const produced = existsSync(artifactPath);
        const fresh = produced
          && (!existedBefore || beforeMtime === undefined || modifiedAt(artifactPath) !== beforeMtime);
        // bz 用退出码 1 表示"有 warning 但已完成"；append 没改 mtime 也可能 legitimately 成功，
        // 所以 append 放宽到 exitCode 0/1 且文件存在。
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
        // A split archive's size lives in its parts: the `.zip` alone is the last
        // fragment, so reporting only that would claim a 6 KB archive is 212 bytes.
        let volumeNote = '';
        if (ok && volumeSize !== undefined) {
          try {
            const dir = path.dirname(artifactPath);
            const stem = path.basename(artifactPath, path.extname(artifactPath));
            const parts = readdirSync(dir)
              .filter((name) => name.startsWith(`${stem}.z`) || name === path.basename(artifactPath))
              .map((name) => ({ name, size: statSync(path.join(dir, name)).size }));
            if (parts.length > 1) {
              const total = parts.reduce((sum, part) => sum + part.size, 0);
              volumeNote = `; split into ${parts.length} parts, ${total} bytes total`;
            }
          } catch {
            // A reported size is a convenience; never fail the create over it.
          }
        }
        const skippedNote = skipped.length === 0
          ? ''
          : `; skipped empty director${skipped.length === 1 ? 'y' : 'ies'} ${skipped.join(', ')}`;
        let verifyNote = '';
        let verified;
        if (ok && args.verify === true) {
          try {
            const checkArgv = ['t', '-y'];
            if (password) checkArgv.push(passwordArg(password, settings.allowPassword));
            checkArgv.push(artifactPath);
            const check = await run(checkArgv);
            verified = check.exitCode === 0;
            if (!verified) verifyNote = `; 已创建但校验不通过（bz 退出码 ${check.exitCode}）`;
          } catch (error) {
            verified = false;
            verifyNote = `; 已创建但校验无法完成（${error instanceof Error ? error.message : String(error)}）`;
          }
        }
        const verb = isAppend ? 'Appended to' : 'Created';
        const summary = ok
          ? `${verb} ${path.basename(artifactPath)} (${format}${size === undefined ? '' : `, ${size} bytes`})${volumeNote}`
            + (isAppend ? ' [append]' : '')
            + (warnings.length === 0 ? '' : ` with ${warnings.length} warning(s)`)
            + skippedNote + verifyNote
          : `bz.exe exited with code ${result.exitCode}`;
        return {
          action, archive: archivePath, ok, exitCode: result.exitCode, summary,
          output: decoded.text, truncated: decoded.truncated, mode: effectiveMode,
          ...(size === undefined ? {} : { size }),
        };
      }

      // ---------------------------------------------------------------- extract
      if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
      const baseName = path.basename(archivePath);
      const stem = baseName.replace(ARCHIVE_EXTENSION, '');
      const besideName = stem === baseName || stem === '' ? `${baseName} extracted` : stem;
      const destinationPath = args.destination
        ? path.resolve(cwd, String(args.destination))
        : path.join(path.dirname(archivePath), besideName);
      if (settings.restrictToWorkspace) assertInsideWorkspace(destinationPath, cwd, 'destination');
      if (destinationPath === archivePath) {
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
      // List once on the untruncated text; every extract feature uses this.
      const listing = await listArchive(run, archivePath, password, settings.allowPassword, encoding);
      if (!listing.ok) {
        return {
          action, archive: archivePath, destination: destinationPath, ok: false,
          exitCode: listing.exitCode, summary: `bz.exe failed to list archive with code ${listing.exitCode}`,
          output: listing.text, truncated: false,
        };
      }
      // Item 11: zip-slip check - reject the whole archive on an unsafe entry name.
      const unsafe = listing.entries.find((e) => {
        // Check the raw (slash-normalized) name too: normalizeEntryPath strips a
        // leading "/", so an absolute entry such as "/etc/passwd" must be caught here.
        const raw = String(e.name).replace(/\\/g, '/');
        const name = normalizeEntryPath(e.name);
        return name.includes('../') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw);
      });
      if (unsafe) {
        return {
          action, archive: archivePath, destination: destinationPath, ok: false, exitCode: -1,
          summary: `Refusing to extract: archive contains an unsafe entry "${unsafe.name}" (path traversal or absolute path).`,
          output: '', truncated: false, rejected: true,
        };
      }
      // Compressed-bomb ceiling. These sizes come from the archive's own headers, so
      // an archive can understate them: this is a cheap early stop, not proof.
      const maxExtractBytes = Number(settings.maxExtractBytes) > 0 ? Number(settings.maxExtractBytes) : 0;
      if (maxExtractBytes > 0) {
        const declaredBytes = listing.entries.reduce(
          (sum, entry) => sum + (Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0), 0,
        );
        if (declaredBytes > maxExtractBytes) {
          return {
            action, archive: archivePath, destination: destinationPath, ok: false, exitCode: -1,
            summary: `Refusing to extract: entries declare ${declaredBytes} bytes, over the ${maxExtractBytes}-byte `
              + 'maxExtractBytes ceiling. Raise that setting if the archive is legitimate.',
            output: '', truncated: false, rejected: true,
          };
        }
      }
      // Symlink entries. Only a ZIP records the entry type (in its central
      // directory), so other formats — and ZIP64, which this scan skips — are simply
      // not covered here; that is documented rather than silently assumed clean.
      if (settings.rejectSymlinkEntries !== false) {
        const symlinkScan = zipSymlinkEntries(archivePath);
        if (symlinkScan.checked && symlinkScan.symlinks.length > 0) {
          const shown = symlinkScan.symlinks.slice(0, 5).map((name) => `"${name}"`).join(', ');
          return {
            action, archive: archivePath, destination: destinationPath, ok: false, exitCode: -1,
            summary: `Refusing to extract: archive contains symlink entries (${shown}`
              + `${symlinkScan.symlinks.length > 5 ? ', …' : ''}). A symlink can redirect later writes outside the `
              + 'destination. Turn off rejectSymlinkEntries only if you trust this archive.',
            output: '', truncated: false, rejected: true,
          };
        }
      }
      const includeMasks = Array.isArray(args.include)
        ? args.include.filter((item) => typeof item === 'string' && item !== '')
        : [];
      const excludeMasks = Array.isArray(args.exclude)
        ? args.exclude.filter((item) => typeof item === 'string' && item !== '')
        : [];
      const matchMask = (name, mask) => compileGlob(normalizeEntryPath(mask)).test(normalizeEntryPath(name));
      const selectedFiles = listing.entries.filter((e) => {
        if (e.isDir) return false;
        if (includeMasks.length > 0 && !includeMasks.some((m) => matchMask(e.name, m))) return false;
        if (excludeMasks.length > 0 && excludeMasks.some((m) => matchMask(e.name, m))) return false;
        return true;
      });
      const overwriteSwitch = OVERWRITE_SWITCH[args.overwrite] ?? OVERWRITE_SWITCH.overwrite;
      const overwriteMode = args.overwrite === undefined ? 'overwrite' : args.overwrite;

      // Item 11: dryRun - no writes; report would-create/overwrite/skip and the
      // first 20 conflicting paths.
      if (args.dryRun === true) {
        let wouldCreate = 0;
        let wouldOverwrite = 0;
        let wouldSkip = 0;
        const conflicts = [];
        for (const entry of selectedFiles) {
          const target = path.join(destinationPath, ...entry.name.split('/').filter(Boolean));
          if (existsSync(target)) {
            if (overwriteMode === 'skip') wouldSkip += 1;
            else { wouldOverwrite += 1; conflicts.push(target); }
          } else {
            wouldCreate += 1;
          }
        }
        return {
          action, archive: archivePath, destination: destinationPath, ok: true, exitCode: 0,
          summary: `Dry run: ${selectedFiles.length} file(s) selected (wouldCreate ${wouldCreate}, wouldOverwrite ${wouldOverwrite}, wouldSkip ${wouldSkip}). No files were written.`,
          output: '', truncated: false, wouldCreate, wouldOverwrite, wouldSkip,
          conflicts: conflicts.slice(0, 20),
        };
      }

      let result;
      let usedOutput = '';
      if (includeMasks.length > 0 && excludeMasks.length === 0) {
        // Item 10: include can be handed straight to bz as backslash masks, with an
        // explicit overwrite switch so bz never waits at an interactive prompt.
        const argv = [args.flat === true ? 'e' : 'x', `-o:${destinationPath}`, overwriteSwitch, '-y'];
        if (password) argv.push(passwordArg(password, settings.allowPassword));
        argv.push(archivePath);
        for (const mask of includeMasks) argv.push(normalizeEntryPath(mask).replace(/\//g, '\\'));
        result = await run(argv);
        usedOutput = decodeWith(result.output, encoding);
      } else if (excludeMasks.length > 0 || includeMasks.length > 0) {
        // Item 10: exclude is implemented by difference - extract selected files
        // one by one with backslash masks (with the same overwrite switch).
        const outputs = [];
        let failed;
        for (const entry of selectedFiles) {
          const mask = entry.name.replace(/\//g, '\\');
          const argv = [args.flat === true ? 'e' : 'x', `-o:${destinationPath}`, overwriteSwitch, '-y'];
          if (password) argv.push(passwordArg(password, settings.allowPassword));
          argv.push(archivePath, mask);
          const one = await run(argv);
          outputs.push(decodeWith(one.output, encoding));
          if (one.exitCode !== 0 && failed === undefined) failed = one.exitCode;
        }
        result = { exitCode: failed ?? 0, output: Buffer.from(outputs.join('\n')) };
        usedOutput = outputs.join('\n');
      } else {
        const argv = [args.flat === true ? 'e' : 'x', `-o:${destinationPath}`, overwriteSwitch, '-y'];
        if (password) argv.push(passwordArg(password, settings.allowPassword));
        argv.push(archivePath);
        result = await run(argv);
        usedOutput = decodeWith(result.output, encoding);
      }
      const decoded = cleanOutput(usedOutput, maxOutputChars);
      const ok = result.exitCode === 0;
      // Item 12: structured manifest of what actually landed (max 500 entries).
      // When include/exclude masks are in play, selectedFiles - not the whole listing -
      // is the truth of what was extracted.
      const maxEntries = 500;
      const files = selectedFiles;
      const top = [...new Set(files.map((e) => normalizeEntryPath(e.name).split('/')[0]))].filter(Boolean);
      const landedFiles = files.slice(0, maxEntries).map((e) => path.resolve(destinationPath, ...e.name.split('/').filter(Boolean)));
      // The counts must describe what this call unpacked. With an include/exclude
      // mask the archive-wide count is a lie: it names entries that were skipped.
      const selectedFileCount = files.filter((e) => !e.isDir).length;
      const selectedFolderCount = files.filter((e) => e.isDir).length;
      const response = {
        action, archive: archivePath, destination: destinationPath, ok, exitCode: result.exitCode,
        summary: ok
          ? `Extracted into ${destinationPath} (${selectedFileCount} files${selectedFolderCount ? `, ${selectedFolderCount} folders` : ''})`
          : `bz.exe exited with code ${result.exitCode}`,
        output: decoded.text, truncated: decoded.truncated,
        files: selectedFileCount, folders: selectedFolderCount,
        entries: files.slice(0, maxEntries).map((e) => ({ name: e.name, size: e.size })),
        entriesTruncated: files.length > maxEntries,
        byExtension: byExtension(files),
        nestedArchives: files.filter((e) => looksLikeArchive(e.name)).map((e) => e.name),
        landedFiles,
      };
      if (top.length === 1 && !files.some((e) => !normalizeEntryPath(e.name).includes('/'))) {
        response.singleTopLevelDir = top[0];
        response.summary += `; 可上提一层（顶层目录 ${top[0]}）`;
      }
      return response;
    },
  });
}
