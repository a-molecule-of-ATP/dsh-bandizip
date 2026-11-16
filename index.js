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

/** Services required to register the tool and resolve the session directory. */
export const inject = ['tools', 'workingDirectory'];

/**
 * A linked plugin cannot resolve `@deepseek-ai/schemastery` from the dsh install,
 * so it is vendored under this package's node_modules (see VENDORED.md). Without
 * this export the plugin had no Configuration projection at all and `bzPath`
 * could never be set from the Settings page.
 */
export const Config = Schema.object({
  bzPath: Schema.string().default('')
    .description('bz.exe full path; empty auto-detects the standard Bandizip install.'),
});

const TOOL_NAME = 'bandizip';
const MAX_OUTPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
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

function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n[... output truncated: ${text.length} characters total]`,
    truncated: true,
  };
}

function cleanOutput(text) {
  return truncateOutput(normalizeOutput(text));
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
function parseLevel(requested) {
  if (requested === undefined || requested === null) return 5;
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
function passwordArg(password) {
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

/** 直接向压缩包要条目数：解压后的统计不能把目标目录里原有的文件算进来。 */
async function listEntryCount(run, archivePath, password) {
  try {
    const argv = ['l', '-y'];
    if (password) argv.push(passwordArg(password));
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
    const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;
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
  throw new Error(
    `Cannot infer an archive format from "${path.basename(archivePath)}". `
      + `Pass format with one of: ${FORMATS.join(', ')}.`,
  );
}

/**
 * Register the bandizip tool.
 * @param ctx - tool registry and working-directory service.
 * @param config - optional `{ bzPath }` row configuration.
 */
export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {};
  let executable;

  function bz() {
    if (executable === undefined) executable = resolveBzPath(pluginConfig.bzPath);
    return executable;
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Compress, extract, inspect, and verify archives with the local Bandizip console tool (bz.exe). '
      + 'Supports zip, zipx, 7z, tar, tgz, gz, xz, iso, lzh, and self-extracting exe; '
      + 'reading rar and other formats is supported by extraction and listing. '
      + 'Relative paths resolve against the session working directory. '
      + 'Actions: create (compress files or folders into a new archive), extract (unpack into a directory), '
      + 'list (show archive contents), test (verify integrity and passwords). '
      + 'The tool is non-interactive: supply password for protected archives, and overwriting files is '
      + 'controlled by overwrite. create refuses to replace an existing archive unless overwrite is '
      + '"overwrite".',
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
            + 'Defaults to a folder named after the archive beside it.',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'create only: archive format. Defaults to the format implied by the archive extension.',
        },
        level: {
          type: 'integer',
          description:
            'create only: compression level from 0 (store) to 9 (maximum). Defaults to 5; '
            + 'a non-integer or out-of-range value is rejected instead of being silently adjusted.',
        },
        password: {
          type: 'string',
          description:
            'Password for creating or reading an encrypted archive. '
            + 'Passed to bz.exe as a command-line switch, so it is visible in the process list.',
        },
        overwrite: {
          type: 'string',
          enum: ['overwrite', 'skip', 'rename'],
          description:
            'extract: what to do with existing files. overwrite replaces them (default), '
            + 'skip leaves them untouched, rename keeps both by renaming the incoming file. '
            + 'create: only overwrite is accepted; any other value makes create fail rather than '
            + 'replace an existing archive.',
        },
        recursive: {
          type: 'boolean',
          description: 'create only: include subdirectories of every folder. Defaults to true.',
        },
        flat: {
          type: 'boolean',
          description: 'extract only: drop directory names and write every file directly into destination. Defaults to false.',
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
      const action = args?.action;
      if (!['create', 'extract', 'list', 'test'].includes(action)) {
        throw new Error(`Unsupported action "${String(action)}". Use create, extract, list, or test.`);
      }
      const cwd = sessionDirectory(ctx, exec);
      const archivePath = path.resolve(cwd, String(args.archive));
      const password = typeof args.password === 'string' && args.password !== '' ? args.password : undefined;
      const run = (argv) => runBz(bz(), argv, { cwd, signal: exec.signal });

      if (action === 'list' || action === 'test') {
        if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
        const argv = [action === 'list' ? 'l' : 't', '-y'];
        if (password) argv.push(passwordArg(password));
        argv.push(archivePath);
        const result = await run(argv);
        // 计数和 filter 都作用在未截断的文本上：先截断会让大压缩包后半截永远搜不到，
        // 也会把结尾的 totals 行一并砍掉。
        const normalized = normalizeOutput(decode(result.output));
        const entryCount = action === 'list' ? countsFromListing(normalized) : undefined;
        const filtered = action === 'list' && typeof args.filter === 'string' && args.filter !== ''
          ? filterListing(normalized, args.filter)
          : normalized;
        const decoded = truncateOutput(filtered);
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
        const format = detectFormat(archivePath, typeof args.format === 'string' ? args.format : undefined);
        const artifactPath = ARCHIVE_EXTENSION.test(path.basename(archivePath))
          ? archivePath
          : `${archivePath}.${format}`;
        const existedBefore = existsSync(artifactPath);
        // bz 的 `c` 会静默替换同名压缩包（help: "Create a new archive (or overwrite an existing file)"），
        // 默认拒绝覆盖，避免悄悄毁掉旧包。
        if (existedBefore && args.overwrite !== 'overwrite') {
          throw new Error(
            `Archive already exists: ${artifactPath}. Pass overwrite:"overwrite" to replace it, `
              + 'or choose another archive name.',
          );
        }
        const beforeMtime = existedBefore ? modifiedAt(artifactPath) : undefined;
        const level = parseLevel(args.level);
        const argv = ['c', `-fmt:${format}`, `-l:${level}`, '-y'];
        // `-r-` alone does NOT stop a directory that is named explicitly from being
        // walked: `bz c -r- out.zip proj` and `bz c -r out.zip proj` produce identical
        // entries (verified against bz 7.47). The switch only constrains wildcard
        // expansion, so `recursive:false` must pass "<dir>\*" to mean one level.
        const shallow = args.recursive === false;
        argv.push(shallow ? '-r-' : '-r');
        if (password) argv.push(passwordArg(password));
        argv.push(archivePath);
        const skipped = [];
        for (const source of sources) {
          const absolute = path.resolve(cwd, source);
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
        const decoded = cleanOutput(decode(result.output));
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
        let summary;
        if (ok) {
          summary = `Created ${path.basename(artifactPath)} (${format}${size === undefined ? '' : `, ${size} bytes`})`
            + (warnings.length === 0 ? '' : ` with ${warnings.length} warning(s)`)
            + skippedNote;
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
      const destinationPath = args.destination
        ? path.resolve(cwd, String(args.destination))
        // 剥不掉扩展名（.001、无扩展名）或整个名字就是扩展名时补后缀：默认目标绝不能与压缩包
        // 同路径、也不能退化成父目录，否则 bz 会把它当目录用并直接报"系统找不到指定的路径"。
        : path.join(
            path.dirname(archivePath),
            stem === baseName || stem === '' ? `${baseName} extracted` : stem,
          );
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
      const overwriteSwitch = OVERWRITE_SWITCH[args.overwrite] ?? OVERWRITE_SWITCH.overwrite;
      const argv = [args.flat === true ? 'e' : 'x', `-o:${destinationPath}`, overwriteSwitch, '-y'];
      if (password) argv.push(passwordArg(password));
      argv.push(archivePath);
      const result = await run(argv);
      const decoded = cleanOutput(decode(result.output));
      const ok = result.exitCode === 0;
      // 统计口径是"压缩包里有多少条"：直接数目标目录会把解压前就存在的文件算进来，
      // 在 overwrite:skip 下尤其误导。清单失败时才退回目录计数。
      const counted = (await listEntryCount(run, archivePath, password))
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
