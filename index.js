/**
 * Host half of the Bandizip bundle: registers one model tool that drives the
 * local Bandizip console executable (bz.exe) for create / extract / list / test.
 *
 * The tool never opens a shell: arguments are passed to bz.exe as an argv array,
 * and stdin is closed so that a missing password fails fast instead of waiting
 * for an interactive prompt.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
  defaultOverwrite: Schema.union([
    Schema.const('overwrite'),
    Schema.const('skip'),
    Schema.const('rename'),
  ]).default('overwrite').volatile()
    .description('解压时未指定 overwrite 的默认策略：覆盖 / 跳过已存在文件 / 保留两者。'),
  defaultFlat: Schema.boolean().default(false).volatile()
    .description('解压时默认是否丢弃目录结构（只保留文件）。'),
  defaultLevel: Schema.natural().default(5).min(0).max(9).volatile()
    .description('create 未指定 level 时使用的压缩级别（0-9）。0 只打包不压缩、速度最快，9 体积最小但明显更慢。'),
  allowArchiveOverwrite: Schema.boolean().default(false).volatile()
    .description('允许 create 覆盖已存在的同名压缩包。关闭时即使显式传 overwrite:"overwrite" 也会被拒绝，用来防止误删旧包。'),
  fallbackFormat: Schema.union([
    Schema.const('auto'),
    Schema.const('zip'),
    Schema.const('7z'),
    Schema.const('tar'),
    Schema.const('tgz'),
    Schema.const('gz'),
    Schema.const('xz'),
  ]).default('auto').volatile()
    .description('压缩包名没有可识别的扩展名时用哪种格式。auto 表示直接报错并让调用方显式传 format。'),
  defaultRecursive: Schema.boolean().default(true).volatile()
    .description('create 未指定 recursive 时是否递归打包子目录。关闭后只打包每层文件，目录结构不再深入。'),
  allowPassword: Schema.boolean().default(true).volatile()
    .description('是否允许把密码交给 bz.exe。关闭后任何带 password 的调用都会失败；密码以 argv 传递，本机其它进程可见。'),
  defaultDestination: Schema.union([
    Schema.const('beside'),
    Schema.const('cwd'),
  ]).default('beside').volatile()
    .description('extract 未指定 destination 时的解压位置。beside 解到压缩包旁的同名文件夹，cwd 解到当前会话工作目录。'),
  verifyAfterCreate: Schema.boolean().default(false).volatile()
    .description('create 成功后自动再跑一次完整性校验。更可靠，但每个压缩包多花一次往返时间。'),
  restrictToWorkspace: Schema.boolean().default(false).volatile()
    .description('拒绝工作区之外的 archive / files / destination。开启后会挡掉工作区外的合法跨盘操作，只在需要强边界时启用。'),
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
/** Fallback format choices: `auto` never guesses, the rest name a real archive format. */
const FALLBACK_FORMATS = ['auto', 'zip', '7z', 'tar', 'tgz', 'gz', 'xz'];
const DESTINATION_MODES = ['beside', 'cwd'];
const BANNER = /^bz [0-9][^\r\n]*Bandisoft[^\r\n]*\r?\n?/gim;
/** bz 的清单结尾行，例如 "180 files, 4 folders"。 */
const COUNT_LINE = /(\d+)\s+files?,\s*(\d+)\s+folders?/i;
/** 默认解压目录要剥掉的压缩包扩展名；tar 必须在列表里，否则目标会等于压缩包本身。 */
const ARCHIVE_EXTENSION = /\.(tar\.gz|tar\.bz2|tgz|tbz2?|tar|zipx?|7z|lzh|lha|iso|gz|xz|rar|exe)$/i;

const FORMATS = ['zip', 'zipx', 'exe', 'tar', 'tgz', 'lzh', 'iso', '7z', 'gz', 'xz'];

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

function decode(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
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
    defaultOverwrite: isOverwriteMode(fallback?.defaultOverwrite) ? fallback.defaultOverwrite : 'overwrite',
    defaultFlat: fallback?.defaultFlat === true,
    // The schema owns the 0..9 bound; this only refuses a value that bypassed it.
    defaultLevel: isLevel(fallback?.defaultLevel) ? fallback.defaultLevel : 5,
    allowArchiveOverwrite: fallback?.allowArchiveOverwrite === true,
    fallbackFormat: isFallbackFormat(fallback?.fallbackFormat) ? fallback.fallbackFormat : 'auto',
    defaultRecursive: fallback?.defaultRecursive !== false,
    allowPassword: fallback?.allowPassword !== false,
    defaultDestination: isDestinationMode(fallback?.defaultDestination) ? fallback.defaultDestination : 'beside',
    verifyAfterCreate: fallback?.verifyAfterCreate === true,
    restrictToWorkspace: fallback?.restrictToWorkspace === true,
  };
  try {
    const entry = ctx.configEditor.entries()
      .find((candidate) => candidate?.options?.name === PACKAGE_NAME);
    const values = entry?.options?.config;
    if (values?.enabled !== undefined) merged.enabled = values.enabled !== false;
    if (typeof values?.bzPath === 'string') merged.bzPath = values.bzPath;
    if (values?.timeoutSeconds !== undefined) merged.timeoutSeconds = clampTimeoutSeconds(values.timeoutSeconds);
    if (values?.maxOutputChars !== undefined) merged.maxOutputChars = clampMaxOutputChars(values.maxOutputChars);
    if (isOverwriteMode(values?.defaultOverwrite)) merged.defaultOverwrite = values.defaultOverwrite;
    if (values?.defaultFlat !== undefined) merged.defaultFlat = values.defaultFlat === true;
    if (values?.defaultLevel !== undefined) merged.defaultLevel = isLevel(values.defaultLevel) ? values.defaultLevel : 5;
    if (values?.allowArchiveOverwrite !== undefined) merged.allowArchiveOverwrite = values.allowArchiveOverwrite === true;
    if (isFallbackFormat(values?.fallbackFormat)) merged.fallbackFormat = values.fallbackFormat;
    if (values?.defaultRecursive !== undefined) merged.defaultRecursive = values.defaultRecursive !== false;
    if (values?.allowPassword !== undefined) merged.allowPassword = values.allowPassword !== false;
    if (isDestinationMode(values?.defaultDestination)) merged.defaultDestination = values.defaultDestination;
    if (values?.verifyAfterCreate !== undefined) merged.verifyAfterCreate = values.verifyAfterCreate === true;
    if (values?.restrictToWorkspace !== undefined) merged.restrictToWorkspace = values.restrictToWorkspace === true;
  } catch {
    // No reachable profile row: keep the activation config.
  }
  return merged;
}

/** `true` when the value is an integer compression level the schema would accept. */
function isLevel(value) {
  return Number.isInteger(value) && value >= 0 && value <= 9;
}

/** `true` when the value names one of the fallback-format choices. */
function isFallbackFormat(value) {
  return typeof value === 'string' && FALLBACK_FORMATS.includes(value);
}

/** `true` when the value names one of the destination modes. */
function isDestinationMode(value) {
  return typeof value === 'string' && DESTINATION_MODES.includes(value);
}

/** `true` when the value names one of the three overwrite switches. */
function isOverwriteMode(value) {
  return typeof value === 'string' && OVERWRITE_SWITCH[value] !== undefined;
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

/** bz 把 warning 混在正常输出里；只看退出码 1 并不知道它丢了哪些文件。 */
function warningsOf(text) {
  return text.split('\n').filter((line) => /^(Warning|Error)\b/.test(line.trim()));
}

/** -l 只接受 0..9 的整数；静默夹取会让调用方以为限定了别的级别。 */
function parseLevel(requested, configuredDefault) {
  if (requested === undefined || requested === null) {
    // The plugin's defaultLevel is the documented "when omitted" source; 5 is only the
    // last resort, matching the schema default.
    return isLevel(configuredDefault) ? configuredDefault : 5;
  }
  if (!Number.isInteger(requested) || requested < 0 || requested > 9) {
    throw new Error(`level must be an integer from 0 to 9, got ${JSON.stringify(requested)}.`);
  }
  return requested;
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
async function listEntryCount(run, archivePath, password, allowPassword) {
  try {
    const argv = ['l', '-y'];
    if (password) argv.push(passwordArg(password, allowPassword));
    argv.push(archivePath);
    const result = await run(argv);
    if (result.exitCode !== 0) return undefined;
    return countsFromListing(normalizeOutput(decode(result.output)));
  } catch {
    return undefined;
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

function detectFormat(archivePath, requested, fallbackFormat = 'auto') {
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
  // A configured fallback answers the ambiguous name; `auto` deliberately still fails so
  // the caller names a format instead of getting a format nobody asked for.
  if (fallbackFormat !== 'auto' && FORMATS.includes(fallbackFormat)) return fallbackFormat;
  throw new Error(
    `Cannot infer an archive format from "${path.basename(archivePath)}". `
      + `Pass format with one of: ${FORMATS.join(', ')}.`,
  );
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
      + 'Actions: create (compress files or folders into a new archive), extract (unpack into a directory), '
      + 'list (show archive contents), test (verify integrity and passwords). '
      + 'The tool is non-interactive: supply password for protected archives (unless the plugin '
      + 'disables passwords). Omitted arguments fall back to the plugin settings: level to '
      + 'defaultLevel, recursive to defaultRecursive, extract overwrite to defaultOverwrite, flat to '
      + 'defaultFlat, and destination to defaultDestination. create refuses to replace an existing '
      + 'archive unless allowArchiveOverwrite is on AND overwrite:"overwrite" is passed explicitly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'extract', 'list', 'test'],
          description: 'Operation to perform.',
        },
        archive: {
          type: 'string',
          description: 'Archive path. The archive to read for extract/list/test, or the archive to write for create.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'create only: files and folders to compress, in the order they are added. '
            + 'Paths inside the archive keep their location relative to the session working directory, '
            + 'so a working-directory-relative path such as "src" appears as "src/..." in the archive.',
        },
        destination: {
          type: 'string',
          description:
            'extract only: folder to unpack into, created when missing. '
            + 'Omit it to follow the plugin\'s defaultDestination setting: "beside" (a folder named '
            + 'after the archive, next to it) or "cwd" (the session working directory).',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description:
            'create only: archive format. Omit it to infer from the archive extension; when the name '
            + 'has no recognizable extension the plugin\'s fallbackFormat setting decides, and '
            + 'fallbackFormat:"auto" fails instead of guessing.',
        },
        level: {
          type: 'integer',
          description:
            'create only: compression level from 0 (store) to 9 (maximum). Omit it to use the '
            + 'plugin\'s defaultLevel setting. A non-integer or out-of-range value is rejected '
            + 'instead of being silently adjusted.',
        },
        password: {
          type: 'string',
          description:
            'Password for creating or reading an encrypted archive. '
            + 'Passed to bz.exe as a command-line switch, so it is visible in the process list. '
            + 'Rejected outright when the plugin\'s allowPassword setting is off.',
        },
        overwrite: {
          type: 'string',
          enum: ['overwrite', 'skip', 'rename'],
          description:
            'extract: what to do with existing files. omit it to use the plugin\'s defaultOverwrite '
            + 'setting (which itself defaults to overwrite). overwrite replaces them, '
            + 'skip leaves them untouched, rename keeps both by renaming the incoming file. '
            + 'create: this argument only gates replacing an existing archive; the plugin\'s '
            + 'defaultOverwrite setting does NOT apply to create. Pass overwrite:"overwrite" to '
            + 'replace an existing archive; create fails otherwise.',
        },
        recursive: {
          type: 'boolean',
          description:
            'create only: include subdirectories of every folder. '
            + 'Omit it to use the plugin\'s defaultRecursive setting.',
        },
        flat: {
          type: 'boolean',
          description:
            'extract only: drop directory names and write every file directly into destination. '
            + 'Omit it to use the plugin\'s defaultFlat setting (which itself defaults to false).',
        },
        filter: {
          type: 'string',
          description: 'list only: case-insensitive text that a listing line must contain to be returned.',
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
          destination: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          summary: { type: 'string' },
          output: { type: 'string' },
          truncated: { type: 'boolean' },
          files: { type: 'integer' },
          folders: { type: 'integer' },
          size: { type: 'integer' },
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
      rawInput: args?.password === undefined
        ? args
        : { ...args, password: '***' },
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
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'test',
    async execute(args, exec) {
      // `enabled` is a `.volatile()` field, so turning it off does not re-run
      // `apply` and cannot unregister this tool. Refuse at call time instead, so
      // the switch still controls behaviour without a reload.
      if (readRowConfig(ctx, pluginConfig).enabled === false) {
        throw new Error('bandizip is disabled in the plugin configuration; enable it on the plugin page to use this tool.');
      }
      const action = args?.action;
      if (!['create', 'extract', 'list', 'test'].includes(action)) {
        throw new Error(`Unsupported action "${String(action)}". Use create, extract, list, or test.`);
      }
      const cwd = sessionDirectory(ctx, exec);
      // One snapshot per call: a volatile write mid-call cannot make the timeout and the
      // output cap disagree with the switches passed to bz.
      const settings = readRowConfig(ctx, pluginConfig);
      const archivePath = path.resolve(cwd, String(args.archive));
      if (settings.restrictToWorkspace) assertInsideWorkspace(archivePath, cwd, 'archive');
      const password = typeof args.password === 'string' && args.password !== '' ? args.password : undefined;
      const maxOutputChars = settings.maxOutputChars;
      const run = (argv) => runBz(bz(), argv, {
        cwd,
        signal: exec.signal,
        timeoutMs: settings.timeoutSeconds * 1000,
      });

      if (action === 'list' || action === 'test') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        const argv = [action === 'list' ? 'l' : 't', '-y'];
        if (password) argv.push(passwordArg(password, settings.allowPassword));
        argv.push(archivePath);
        const result = await run(argv);
        // 计数和 filter 都作用在未截断的文本上：先截断会让大压缩包后半截永远搜不到，
        // 也会把结尾的 totals 行一并砍掉。
        const normalized = normalizeOutput(decode(result.output));
        const entryCount = action === 'list' ? countsFromListing(normalized) : undefined;
        const filtered = action === 'list' && typeof args.filter === 'string' && args.filter !== ''
          ? filterListing(normalized, args.filter)
          : normalized;
        const decoded = truncateOutput(filtered, maxOutputChars);
        const ok = result.exitCode === 0;
        const summary = ok
          ? action === 'list'
            ? `Listed ${path.basename(archivePath)}`
              + (entryCount ? ` (${entryCount.files} files, ${entryCount.folders} folders)` : '')
            : `Archive ${path.basename(archivePath)} passed the integrity test`
          : `bz.exe exited with code ${result.exitCode}`;
        return {
          action,
          archive: archivePath,
          ok,
          exitCode: result.exitCode,
          summary,
          output: decoded.text,
          truncated: decoded.truncated,
          ...(entryCount ?? {}),
        };
      }

      if (action === 'create') {
        const sources = Array.isArray(args.files) ? args.files.filter((item) => typeof item === 'string') : [];
        if (sources.length === 0) throw new Error('create requires files: at least one file or folder to compress.');
        // bz appends the format extension to a name without one (`x` → `x.zip`), so the
        // overwrite guard and every later check must watch the name that lands on disk.
        const format = detectFormat(
          archivePath,
          typeof args.format === 'string' ? args.format : undefined,
          settings.fallbackFormat,
        );
        const artifactPath = ARCHIVE_EXTENSION.test(path.basename(archivePath))
          ? archivePath
          : `${archivePath}.${format}`;
        const existedBefore = existsSync(artifactPath);
        // bz 的 `c` 会静默替换同名压缩包（help: "Create a new archive (or overwrite an existing file)"）。
        // 两道闸门：① 配置层 allowArchiveOverwrite 关着时，显式参数也不放行 —— 这是“防手滑”
        // 的总开关；② 配置放开后，仍需显式传 overwrite:"overwrite"，避免默认行为悄悄毁包。
        // `defaultOverwrite` 是解压默认值，刻意不参与此判断。
        if (existedBefore && settings.allowArchiveOverwrite === false) {
          throw new Error(
            `Archive already exists: ${artifactPath}. Replacing it is disabled by the plugin `
              + 'configuration (allowArchiveOverwrite: false). Enable it on the plugin page, '
              + 'or choose another archive name.',
          );
        }
        if (existedBefore && args.overwrite !== 'overwrite') {
          throw new Error(
            `Archive already exists: ${artifactPath}. Pass overwrite:"overwrite" to replace it, `
              + 'or choose another archive name.',
          );
        }
        const beforeMtime = existedBefore ? modifiedAt(artifactPath) : undefined;
        const level = parseLevel(args.level, settings.defaultLevel);
        const argv = ['c', `-fmt:${format}`, `-l:${level}`, '-y'];
        // `-r-` alone does NOT stop a directory that is named explicitly from being
        // walked: `bz c -r- out.zip proj` and `bz c -r out.zip proj` produce identical
        // entries (verified against bz 7.47). The switch only constrains wildcard
        // expansion, so `recursive:false` must pass "<dir>\*" to mean one level.
        // Explicit `recursive` beats `defaultRecursive` beats the hard-coded true.
        const shallow = (args.recursive ?? settings.defaultRecursive) === false;
        argv.push(shallow ? '-r-' : '-r');
        if (password) argv.push(passwordArg(password, settings.allowPassword));
        argv.push(archivePath);
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
            // `<dir>\\*` means one level, but an empty directory has nothing to expand and
            // bz answers "No files to archive" (exit 2). Record it instead of failing the run.
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
          // A name starting with "-" would be read as a switch (e.g. "-r"), and bz
          // answers with "No files to archive". A "./" prefix keeps it a path.
          argv.push(entry.startsWith('-') ? `./${entry}` : entry);
        }
        if (sources.length > 0 && skipped.length === sources.length) {
          throw new Error(
            'No files to archive: every source was an empty directory ('
            + skipped.join(', ') + '). Pass another source or recursive:true.',
          );
        }
        const result = await run(argv);
        const decoded = cleanOutput(decode(result.output), maxOutputChars);
        const produced = existsSync(artifactPath);
        // An unreadable mtime cannot prove staleness; `produced` already proves the file exists.
        const fresh = produced
          && (!existedBefore || beforeMtime === undefined || modifiedAt(artifactPath) !== beforeMtime);
        // bz 用退出码 1 表示"有 warning 但已完成"；只有确实写出了新文件才认这个成功，
        // 退出码 2（例如 No files to archive）永远算失败。
        const ok = result.exitCode === 0 ? produced : result.exitCode === 1 && fresh;
        const warnings = ok ? warningsOf(decoded.text) : [];
        let size;
        if (ok) {
          try {
            size = statSync(artifactPath).size;
          } catch {
            size = undefined;
          }
        }
        const skippedNote = skipped.length === 0
          ? ''
          : `; skipped empty director${skipped.length === 1 ? 'y' : 'ies'} ${skipped.join(', ')}`;
        // An opt-in self-check: the archive was produced, but a truncated or corrupt write
        // would still exit 0. The create is NOT rolled back — the file is reported as made
        // with a warning, so the caller keeps control of a possibly-usable artifact.
        let verifyNote = '';
        let verified;
        if (ok && settings.verifyAfterCreate) {
          try {
            const checkArgv = ['t', '-y'];
            if (password) checkArgv.push(passwordArg(password, settings.allowPassword));
            checkArgv.push(artifactPath);
            const check = await run(checkArgv);
            verified = check.exitCode === 0;
            if (!verified) {
              verifyNote = `; 已创建但校验不通过（bz 退出码 ${check.exitCode}）`;
            }
          } catch (error) {
            verified = false;
            verifyNote = `; 已创建但校验无法完成（${error instanceof Error ? error.message : String(error)}）`;
          }
        }
        let summary;
        if (ok) {
          summary = `Created ${path.basename(artifactPath)} (${format}${size === undefined ? '' : `, ${size} bytes`})`
            + (warnings.length === 0 ? '' : ` with ${warnings.length} warning(s)`)
            + skippedNote
            + verifyNote;
        } else if (result.exitCode === 0) {
          summary = `bz.exe exited with code 0 but did not create ${path.basename(artifactPath)}.`;
        } else {
          summary = `bz.exe exited with code ${result.exitCode}`;
        }
        return {
          action,
          archive: archivePath,
          ok,
          exitCode: result.exitCode,
          summary,
          output: decoded.text,
          truncated: decoded.truncated,
          ...(size === undefined ? {} : { size }),
        };
      }

      // extract
      if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
      const baseName = path.basename(archivePath);
      const stem = baseName.replace(ARCHIVE_EXTENSION, '');
      // 剥不掉扩展名（.001、无扩展名）或整个名字就是扩展名时补后缀：默认目标绝不能与压缩包
      // 同路径、也不能退化成父目录，否则 bz 会把它当目录用并直接报"系统找不到指定的路径"。
      const besideName = stem === baseName || stem === '' ? `${baseName} extracted` : stem;
      // Explicit argument beats `defaultDestination` (`cwd` = session working directory,
      // `beside` = a folder named after the archive next to it).
      const destinationPath = args.destination
        ? path.resolve(cwd, String(args.destination))
        : settings.defaultDestination === 'cwd'
          ? path.join(cwd, besideName)
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
      // Explicit argument beats the plugin's default beats the hard-coded fallback. `??`
      // (not `||`) is required: an explicit `flat: false` must override `defaultFlat: true`.
      const overwriteSwitch = OVERWRITE_SWITCH[args.overwrite ?? settings.defaultOverwrite]
        ?? OVERWRITE_SWITCH.overwrite;
      const argv = [(args.flat ?? settings.defaultFlat) === true ? 'e' : 'x', `-o:${destinationPath}`, overwriteSwitch, '-y'];
      if (password) argv.push(passwordArg(password, settings.allowPassword));
      argv.push(archivePath);
      const result = await run(argv);
      const decoded = cleanOutput(decode(result.output), maxOutputChars);
      const ok = result.exitCode === 0;
      // 统计口径是"压缩包里有多少条"：直接数目标目录会把解压前就存在的文件算进来，
      // 在 overwrite:skip 下尤其误导。清单失败时才退回目录计数。
      const counted = (await listEntryCount(run, archivePath, password, settings.allowPassword))
        ?? (existsSync(destinationPath) ? countFiles(destinationPath) : { files: 0, folders: 0 });
      return {
        action,
        archive: archivePath,
        destination: destinationPath,
        ok,
        exitCode: result.exitCode,
        summary: ok
          ? `Extracted into ${destinationPath} (${counted.files} files${counted.folders ? `, ${counted.folders} folders` : ''})`
          : `bz.exe exited with code ${result.exitCode}`,
        output: decoded.text,
        truncated: decoded.truncated,
        files: counted.files,
        folders: counted.folders,
      };
    },
  });
}
