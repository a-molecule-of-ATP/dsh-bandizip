/**
 * Stress harness for the nine bandizip tools.
 *
 * It fakes the parts of DSH the plugin touches (tool registry, working directory, config
 * row) and exercises the paths a real install would hit, including real bz.exe calls when
 * the executable is present. Run with: node tools-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { apply, sniffFormat, TOOL_NAMES } from './index.js';

let failures = 0;
let passes = 0;
const log = [];
function record(ok, name, detail) {
  if (ok) {
    passes += 1;
    log.push(`PASS  ${name}`);
  } else {
    failures += 1;
    log.push(`FAIL  ${name}\n      ${detail}`);
  }
}
function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('assertion returned false');
    record(true, name);
  } catch (error) {
    record(false, name, error instanceof Error ? error.message : String(error));
  }
}
async function checkAsync(name, fn) {
  try {
    const result = await fn();
    if (result === false) throw new Error('assertion returned false');
    record(true, name);
  } catch (error) {
    record(false, name, error instanceof Error ? error.message : String(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}
async function assertRejects(fn, pattern) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    if (pattern && !pattern.test(message)) {
      throw new Error(`rejected with "${message}" which does not match ${pattern}`);
    }
  }
  if (!threw) throw new Error('did not reject');
}

// ── fake DSH environment ────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'dsh-bandizip-test-'));
const PACKAGE = '@local/bandizip';

/**
 * Register the plugin against a fake context and return the tool definitions by name.
 * `cwd` is what the plugin sees as the session working directory.
 */
function mount(overrides = {}, cwd = ROOT) {
  const tools = new Map();
  const config = {
    enabled: true,
    bzPath: '',
    timeoutSeconds: 120,
    maxOutputChars: 12000,
    allowArchiveOverwrite: true,
    allowPassword: true,
    restrictToWorkspace: false,
    maxExtractBytes: 0,
    rejectSymlinkEntries: true,
    ...overrides,
  };
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    workingDirectory: { get: () => cwd },
    configEditor: { entries: () => [{ options: { name: PACKAGE, config } }] },
  };
  apply(ctx, config);
  return { tools, cwd, config };
}

/** Call one tool the way the host would: execute(args, exec) with a session-bearing exec. */
function call(tools, name, args, cwd = ROOT) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool.execute(args, { agent: { session: {} }, signal: undefined });
}

const workspace = path.join(ROOT, 'work');

/**
 * Write a minimal ustar by hand, because bz.exe cannot be asked to store a symbolic link on
 * Windows and the tar branch of the symlink policy needs one to test against.
 */
function tarHeader(name, size, typeflag, linkname) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 'latin1');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(typeflag, 156, 'latin1');
  if (linkname !== undefined) block.write(linkname, 157, 'latin1');
  block.write('ustar\x0000', 257, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function makeTar(target, { content, link }) {
  const data = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  const parts = [tarHeader('real.txt', data.length, '0'), padded];
  if (link !== undefined) parts.push(tarHeader(link.name, 0, '2', link.target));
  parts.push(Buffer.alloc(1024));
  const absolute = path.join(workspace, target);
  writeFileSync(absolute, Buffer.concat(parts));
  return absolute;
}


/**
 * Write a minimal ZIP (stored entries) by hand.
 *
 * bz.exe will not produce the two archives the safety checks exist for — a zip-slip entry and
 * a symlink entry — so the only way to test them is to build the bytes here. Layout per the
 * PKZIP appnote: local header + data per entry, then the central directory, then EOCD.
 */
function makeZip(target, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content ?? '', 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // Unix mode in the high 16 bits: 0o100644 regular, 0o120777 symlink (S_IFLNK).
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  const absolute = path.join(workspace, target);
  writeFileSync(absolute, Buffer.concat([...locals, centralBlock, eocd]));
  return absolute;
}


// ── 1. magic-byte identification ────────────────────────────────────────
function makeFile(name, bytes) {
  const target = path.join(workspace, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return target;
}

const MAGIC_CASES = [
  { name: 'zip-local', head: [0x50, 0x4b, 0x03, 0x04], expect: 'zip' },
  { name: 'zip-empty', head: [0x50, 0x4b, 0x05, 0x06], expect: 'zip' },
  { name: 'zip-spanned', head: [0x50, 0x4b, 0x07, 0x08], expect: 'zip' },
  { name: '7z', head: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], expect: '7z' },
  { name: 'rar', head: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], expect: 'rar' },
  { name: 'gzip', head: [0x1f, 0x8b, 0x08, 0x00], expect: 'gz' },
  { name: 'xz', head: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00], expect: 'xz' },
  { name: 'bzip2', head: [0x42, 0x5a, 0x68, 0x39], expect: 'bzip2' },
  { name: 'zstd', head: [0x28, 0xb5, 0x2f, 0xfd, 0x00], expect: 'zstd' },
  { name: 'lzh', head: [0x1b, 0xf1, 0x2d, 0x6c, 0x68, 0x37], expect: 'lzh' },
  { name: 'cab', head: [...Buffer.from('MSCF')], expect: 'cab' },
  { name: 'sfx-exe', head: [...Buffer.from('MZ\x90\x00')], expect: 'exe' },
];

function paddedFile(name, prefix, offset, marker, total) {
  const buffer = Buffer.alloc(total ?? offset + marker.length);
  if (prefix !== undefined) Buffer.from(prefix).copy(buffer, 0);
  Buffer.from(marker).copy(buffer, offset);
  return makeFile(name, buffer);
}

await (async () => {
  const toolsBefore = mount().tools;
  for (const item of MAGIC_CASES) {
    const target = makeFile(`${item.name}.bin`, Buffer.from(item.head));
    check(`sniffFormat: ${item.name}`, () => {
      const detected = sniffFormat(target);
      assert(detected !== null, 'no signature matched');
      assert(detected.format === item.expect, `expected ${item.expect}, got ${detected.format}`);
      assert(detected.confidence === 'magic', `confidence was ${detected.confidence}`);
    });
  }
  const tarFile = paddedFile('payload.tar', 'a.txt', 257, 'ustar', 512);
  check('sniffFormat: tar at offset 257', () => {
    assert(sniffFormat(tarFile)?.format === 'tar', 'tar not recognised');
  });
  const isoFile = paddedFile('disc.iso', undefined, 0x8001, 'CD001', 0x8001 + 5);
  check('sniffFormat: iso at offset 0x8001', () => {
    assert(sniffFormat(isoFile)?.format === 'iso', 'iso not recognised');
  });
  const tgzish = makeFile('bundle.tar.gz', Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
  check('sniffFormat: gzip payload named .tar.gz is tgz', () => {
    assert(sniffFormat(tgzish)?.format === 'tgz', 'tgz not recognised');
  });
  const text = makeFile('notes.txt', 'plain text, no archive here\n');
  check('sniffFormat: plain text is not an archive', () => {
    assert(sniffFormat(text) === null, `matched ${sniffFormat(text)?.format}`);
  });
  const tiny = makeFile('one.bin', Buffer.from([0x50]));
  check('sniffFormat: a one-byte file matches nothing', () => {
    assert(sniffFormat(tiny) === null, 'short file matched a signature');
  });
  check('sniffFormat: a missing file returns null, not a throw', () => {
    assert(sniffFormat(path.join(workspace, 'does-not-exist.zip')) === null, 'missing file returned a value');
  });

  // detect_format must report the extension-only answer as not-an-archive.
  await checkAsync('detect_format: a non-archive is an answer, not an error', async () => {
    const result = await call(toolsBefore, 'detect_format', { path: text });
    assert(result.format === 'unknown', `format ${result.format}`);
    assert(result.confidence === 'unknown', `confidence ${result.confidence}`);
    assert(result.isArchive === false, 'isArchive true for plain text');
    assert(typeof result.note === 'string' && result.note !== '', 'no explanation');
  });
  await checkAsync('detect_format: extension-only answers say isArchive:false', async () => {
    const named = makeFile('looks-like.zip', 'not really a zip\n');
    const result = await call(toolsBefore, 'detect_format', { path: named });
    if (result.confidence === 'extension') {
      assert(result.isArchive === false, 'an extension-only answer claimed isArchive:true');
    }
    assert(result.format !== undefined, 'no format');
    assert(typeof result.encryptedGuess !== 'undefined', 'encryptedGuess missing');
  });
})();

// ── 2. tool registration, parameter scope, argument refusal ─────────────
const EXPECTED_TOOLS = [
  'list_archive', 'extract_archive', 'create_archive', 'compress_file', 'decompress_file',
  'check_archive', 'detect_format', 'diff_archive', 'convert_archive',
];

/** A parameter that belongs to exactly one other tool, per target tool. */
const FOREIGN_ARGUMENT = {
  list_archive: 'dryRun',
  extract_archive: 'volumeSize',
  create_archive: 'dryRun',
  compress_file: 'archive',
  decompress_file: 'password',
  check_archive: 'filter',
  detect_format: 'archive',
  diff_archive: 'files',
  convert_archive: 'symlinks',
};

await (async () => {
  const { tools } = mount();
  check(`registration: ${EXPECTED_TOOLS.length} tools registered`, () => {
    assert(tools.size === EXPECTED_TOOLS.length, `registered ${tools.size}: ${[...tools.keys()].join(', ')}`);
    for (const name of EXPECTED_TOOLS) assert(tools.has(name), `${name} is missing`);
    for (const name of TOOL_NAMES) assert(tools.has(name), `TOOL_NAMES lists ${name} but it is not registered`);
  });
  check('registration: every tool has a description and an execute', () => {
    for (const tool of tools.values()) {
      assert(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} description too short`);
      assert(typeof tool.execute === 'function', `${tool.name} has no execute`);
      assert(typeof tool.output?.schema === 'object', `${tool.name} has no output schema`);
    }
  });
  check('registration: every tool sets additionalProperties:false on parameters', () => {
    for (const tool of tools.values()) {
      assert(tool.parameters.additionalProperties === false, `${tool.name} allows extra parameters`);
    }
  });
  check('registration: every tool names its required parameters', () => {
    for (const tool of tools.values()) {
      assert(Array.isArray(tool.parameters.required) && tool.parameters.required.length > 0, `${tool.name} declares no required parameter`);
      for (const field of tool.parameters.required) {
        assert(Object.hasOwn(tool.parameters.properties, field), `${tool.name} requires undeclared ${field}`);
      }
    }
  });
  check('registration: each output schema is its own object, not a shared union', () => {
    // Identity, not structure: two tools may describe the same shape, but they must not be
    // handed the same mutable object, which is how a union schema grows a field nobody reads.
    const schemas = [...tools.values()].map((tool) => tool.output.schema);
    assert(new Set(schemas).size === schemas.length, 'two tools share one output schema object');
    for (const tool of tools.values()) {
      const count = Object.keys(tool.output.schema.properties).length;
      assert(count <= 20, `${tool.name} declares ${count} output fields`);
      assert(tool.output.schema.additionalProperties === false, `${tool.name} output allows extra fields`);
    }
  });
  check('registration: only timeoutSeconds is shared by every tool', () => {
    // A field every tool accepts is the union problem coming back. timeoutSeconds is the one
    // exception, and only because every tool can reach bz.exe or override the call timeout.
    const names = [...tools.values()].map((tool) => Object.keys(tool.parameters.properties));
    const shared = names[0].filter((field) => names.every((list) => list.includes(field)));
    assert(shared.length === 1 && shared[0] === 'timeoutSeconds', `shared by every tool: ${shared.join(', ') || '(none)'}`);
  });

  for (const [name, foreign] of Object.entries(FOREIGN_ARGUMENT)) {
    await checkAsync(`scope: ${name} rejects the foreign argument "${foreign}"`, async () => {
      const tool = tools.get(name);
      assert(!Object.hasOwn(tool.parameters.properties, foreign), `${foreign} is declared by ${name}`);
      await assertRejects(() => call(tools, name, { [foreign]: true }), /does not take/);
    });
  }
  await checkAsync('scope: stats / flat / recursive each belong to one tool', async () => {
    assert(Object.hasOwn(tools.get('list_archive').parameters.properties, 'stats'), 'list_archive lost stats');
    assert(Object.hasOwn(tools.get('extract_archive').parameters.properties, 'flat'), 'extract_archive lost flat');
    assert(Object.hasOwn(tools.get('create_archive').parameters.properties, 'recursive'), 'create_archive lost recursive');
    // …and no other tool declares them.
    for (const [argument, owner] of [['stats', 'list_archive'], ['flat', 'extract_archive'], ['recursive', 'create_archive']]) {
      for (const tool of tools.values()) {
        const owns = Object.hasOwn(tool.parameters.properties, argument);
        assert(owns === (tool.name === owner), `${argument} on ${tool.name} (owner: ${owner})`);
      }
    }
    await assertRejects(() => call(tools, 'check_archive', { archive: 'x.zip', stats: true }), /does not take/);
    await assertRejects(() => call(tools, 'list_archive', { archive: 'x.zip', flat: true }), /does not take/);
    await assertRejects(() => call(tools, 'extract_archive', {
      archive: 'x.zip', destination: 'o', overwrite: 'overwrite', recursive: false,
    }), /does not take/);
  });

  await checkAsync('scope: unknown argument names are listed in the rejection', async () => {
    await assertRejects(() => call(tools, 'list_archive', { archive: 'x.zip', depth: 2 }), /"depth"/);
  });
  for (const [name, args, missing] of [
    ['list_archive', {}, 'archive'],
    ['extract_archive', { archive: 'a.zip', overwrite: 'overwrite' }, 'destination'],
    ['extract_archive', { archive: 'a.zip', destination: 'out' }, 'overwrite'],
    ['create_archive', { archive: 'a.zip' }, 'files'],
    ['compress_file', { file: 'a.txt' }, 'format'],
    ['diff_archive', { archive: 'a.zip' }, 'archive2'],
    ['detect_format', {}, 'path'],
  ]) {
    await checkAsync(`scope: ${name} refuses a call without "${missing}"`, async () => {
      await assertRejects(() => call(tools, name, args), new RegExp(`requires "${missing}"`));
    });
  }
  await checkAsync('scope: a disabled plugin refuses every call', async () => {
    const off = mount({ enabled: false }).tools;
    assert(off.size === 0, 'a disabled plugin still registered tools');
  });
})();

// ── 3. gz / zstd roundtrip (node:zlib only: no bz.exe involved) ─────────
const SAMPLE = Buffer.from(`${'bandizip '.repeat(400)}end\n`);

await (async () => {
  const { tools } = mount();
  const source = makeFile('sample.txt', SAMPLE);
  for (const format of ['gz', 'zstd']) {
    await checkAsync(`roundtrip: ${format} compress -> decompress returns identical bytes`, async () => {
      const compressed = await call(tools, 'compress_file', { file: source, format, overwrite: true });
      assert(compressed.ok === true, 'compress_file did not report ok');
      assert(compressed.format === format, `format ${compressed.format}`);
      assert(statSync(compressed.output).size === compressed.outputBytes, 'reported size is not the file size');
      assert(compressed.outputBytes < SAMPLE.length, 'compressed output is not smaller');

      const restored = path.join(workspace, `restored-${format}.txt`);
      const unpacked = await call(tools, 'decompress_file', { file: compressed.output, destination: restored, overwrite: true });
      assert(unpacked.ok === true, 'decompress_file did not report ok');
      assert(readFileSync(unpacked.output).equals(SAMPLE), 'content differs after the roundtrip');
    });
  }
  await checkAsync('roundtrip: xz compress -> decompress returns identical bytes', async () => {
    // xz has no node:zlib codec, so this path goes through bz.exe — the whole point of the
    // delegation is that a caller cannot tell the difference, hence the same assertion.
    const compressed = await call(tools, 'compress_file', {
      file: source, format: 'xz', destination: path.join(workspace, 'sample.txt.xz'), overwrite: true,
    });
    assert(compressed.ok === true, 'xz compress did not report ok');
    assert(compressed.outputBytes === statSync(compressed.output).size, 'reported size is not the file size');
    const restored = path.join(workspace, 'restored-xz.txt');
    const unpacked = await call(tools, 'decompress_file', {
      file: compressed.output, destination: restored, overwrite: true,
    });
    assert(unpacked.ok === true, 'xz decompress did not report ok');
    assert(readFileSync(unpacked.output).equals(SAMPLE), 'content differs after the xz roundtrip');
  });

  await checkAsync('zstd: the runtime-missing guard exists (source-level check, cannot be triggered here)', async () => {
    const originalCompress = Object.getOwnPropertyDescriptor;
    // Simulating a runtime without zstd would mean monkey-patching node:zlib globally; the
    // honest check is that the guard exists and names the failure mode.
    const sourceText = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    assert(sourceText.includes('has no zstd support'), 'no zstd-missing error is written');
    assert(typeof originalCompress === 'function', 'unreachable');
  });
  await checkAsync('compress_file: an existing output is not replaced silently', async () => {
    const target = path.join(workspace, 'collide.gz');
    writeFileSync(target, 'keep me');
    await assertRejects(() => call(tools, 'compress_file', { file: source, format: 'gz', destination: target }), /already exists/);
    assert(readFileSync(target, 'utf8') === 'keep me', 'the existing file was modified');
  });
  await checkAsync('compress_file: xz is produced through bz.exe', async () => {
    // The xz path is delegated to bz.exe, so this asserts the branch is reachable at all.
    const result = await call(tools, 'compress_file', { file: source, format: 'xz', overwrite: true });
    assert(result.format === 'xz', 'xz not reported');
    assert(existsSync(result.output), 'no xz output');
  });
})();

// ── 4. real bz.exe behaviour (skipped when Bandizip is not installed) ───
const BZ_CANDIDATES = [
  process.env.BANDIZIP_BZ,
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Bandizip', 'bz.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Bandizip', 'bz.exe'),
].filter((candidate) => typeof candidate === 'string' && candidate !== '');
const bzFound = BZ_CANDIDATES.some((candidate) => existsSync(candidate));

if (!bzFound) {
  log.push('SKIP  bz.exe not found: the engine-backed cases (encryption, volumes, create, extract,');
  log.push('      check, diff, convert) did not run on this machine.');
} else {
  const { tools } = mount({ rejectSymlinkEntries: true, allowArchiveOverwrite: true });
  const tree = path.join(workspace, 'tree');
  mkdirSync(path.join(tree, 'sub', 'deep'), { recursive: true });
  mkdirSync(path.join(tree, 'empty'), { recursive: true });
  writeFileSync(path.join(tree, 'a.txt'), 'hello world\n');
  writeFileSync(path.join(tree, 'sub', 'b.txt'), 'second file content\n');
  writeFileSync(path.join(tree, 'sub', 'deep', 'c.txt'), 'third level content\n');

  await checkAsync('create_archive: a zip is produced and reported', async () => {
    const archive = path.join(workspace, 'plain.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'a.txt'), path.join(tree, 'sub', 'b.txt')],
      format: 'zip', level: 5, overwrite: 'overwrite', verify: true,
    });
    assert(created.ok === true, `create failed: ${created.note ?? ''}`);
    assert(existsSync(archive), 'no archive on disk');
    assert(created.format === 'zip', `format ${created.format}`);
    assert(typeof created.digest?.hex === 'string' && created.digest.hex.length === 64, 'no sha256 digest');
    assert(created.verified === true, 'verify:true did not report verified');
  });

  await checkAsync('list_archive: entries, format and not-encrypted are reported', async () => {
    const listed = await call(tools, 'list_archive', { archive: path.join(workspace, 'plain.zip') });
    assert(listed.ok === true, 'list failed');
    assert(listed.format === 'zip', `format ${listed.format}`);
    assert(listed.encrypted === false, `encrypted ${JSON.stringify(listed.encrypted)}`);
    assert(listed.total === 2, `total ${listed.total}`);
    assert(listed.volumes.split === false && listed.volumes.parts === 1, 'volumes wrong for a single file');
    assert(listed.totalUncompressedBytes > 0, 'no uncompressed byte count');
  });

  await checkAsync('list_archive: filter and pagination agree with each other', async () => {
    const page = await call(tools, 'list_archive', { archive: path.join(workspace, 'plain.zip'), limit: 1 });
    assert(page.entries.length === 1, `page size ${page.entries.length}`);
    assert(page.nextOffset === 1, `nextOffset ${page.nextOffset}`);
    const rest = await call(tools, 'list_archive', { archive: path.join(workspace, 'plain.zip'), limit: 1, offset: 1 });
    assert(rest.entries[0].name !== page.entries[0].name, 'paging returned the same entry twice');
    const filtered = await call(tools, 'list_archive', { archive: path.join(workspace, 'plain.zip'), filter: 'b.txt' });
    assert(filtered.total === 1, `filter matched ${filtered.total}`);
  });

  await checkAsync('list_archive: encrypted ZIP is detected from the central directory', async () => {
    const archive = path.join(workspace, 'secret.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'a.txt')], format: 'zip', password: 'pw',
      overwrite: 'overwrite',
    });
    assert(created.ok === true, `encrypted create failed: ${created.note ?? ''}`);
    const listed = await call(tools, 'list_archive', { archive, password: 'pw' });
    assert(listed.encrypted === true, `encrypted reported as ${JSON.stringify(listed.encrypted)}`);
    assert(/zip-central-directory/.test(listed.note ?? ''), `the probe provenance is missing from note: ${listed.note}`);
  });

  await checkAsync('list_archive: split volumes are counted from the sibling fragments', async () => {
    const archive = path.join(workspace, 'split.zip');
    const big = path.join(workspace, 'random.bin');
    writeFileSync(big, randomBytes(400000));
    const created = await call(tools, 'create_archive', {
      archive, files: [big], format: 'zip', level: 1, volumeSize: '100k', overwrite: 'overwrite',
    });
    assert(created.ok === true, `split create failed: ${created.note ?? ''}`);
    assert(created.parts > 1, `create reported ${created.parts} parts`);
    const listed = await call(tools, 'list_archive', { archive });
    assert(listed.volumes.split === true, 'split archive not reported as split');
    assert(listed.volumes.parts === created.parts, `parts ${listed.volumes.parts} vs ${created.parts}`);
  });

  await checkAsync('extract_archive: files land and conflicts are reported', async () => {
    const target = path.join(workspace, 'out');
    const extracted = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite',
    });
    assert(extracted.ok === true, `extract failed: ${extracted.note ?? ''}`);
    assert(extracted.extracted === 2, `extracted ${extracted.extracted}`);
    const landed = extracted.entries.map((entry) => entry.landed);
    for (const file of landed) assert(existsSync(file), `${file} did not land`);
    assert(landed.some((file) => file.endsWith('a.txt')), 'a.txt is not among the landed files');
    const again = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'skip',
    });
    assert(again.conflicts.length === 2, `conflicts ${again.conflicts.length}`);
    assert(again.skipped === 2, `skipped ${again.skipped}`);
  });

  await checkAsync('extract_archive: dryRun writes nothing', async () => {
    const target = path.join(workspace, 'dry');
    const dry = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite', dryRun: true,
    });
    assert(dry.wouldCreate === 2, `wouldCreate ${dry.wouldCreate}`);
    assert(!existsSync(target), 'dryRun created the destination');
  });

  await checkAsync('extract_archive: a failed checksum refuses before writing', async () => {
    const target = path.join(workspace, 'wrongsum');
    const result = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite',
      checksum: `sha256:${'0'.repeat(64)}`,
    });
    assert(result.ok === false && result.rejected === true, 'a bad checksum was accepted');
    assert(!existsSync(target), 'nothing should have been written');
  });

  await checkAsync('check_archive: integrity and a matching checksum are both reported', async () => {
    const archive = path.join(workspace, 'plain.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'a.txt')], format: 'zip', overwrite: 'overwrite',
    });
    assert(created.ok === true, 'setup create failed');
    const digest = created.digest.hex;
    const checked = await call(tools, 'check_archive', { archive, checksum: digest });
    assert(checked.integrity === 'ok', `integrity ${checked.integrity}`);
    assert(checked.checksum.matched === true, 'checksum did not match');
    assert(checked.checksum.algorithm === 'sha256', `algorithm ${checked.checksum.algorithm}`);
    const bad = await call(tools, 'check_archive', { archive, checksum: `md5:${'0'.repeat(32)}` });
    assert(bad.ok === false && bad.checksum.matched === false, 'a wrong digest was accepted');
  });

  await checkAsync('check_archive: a malformed checksum is refused with a readable message', async () => {
    await assertRejects(
      () => call(tools, 'check_archive', { archive: path.join(workspace, 'plain.zip'), checksum: 'sha256:zzz' }),
      /hex/,
    );
    await assertRejects(
      () => call(tools, 'check_archive', { archive: path.join(workspace, 'plain.zip'), checksum: 'abc' }),
      /Cannot infer an algorithm/,
    );
  });

  await checkAsync('detect_format: a renamed archive is identified by its bytes', async () => {
    const renamed = path.join(workspace, 'looks-like.txt');
    writeFileSync(renamed, readFileSync(path.join(workspace, 'plain.zip')));
    const detected = await call(tools, 'detect_format', { path: renamed });
    assert(detected.format === 'zip', `format ${detected.format}`);
    assert(detected.confidence === 'magic', `confidence ${detected.confidence}`);
    assert(detected.isArchive === true, 'isArchive false for a real archive');
    assert(detected.encryptedGuess === false, `encryptedGuess ${JSON.stringify(detected.encryptedGuess)}`);
  });

  await checkAsync('detect_format: an encrypted ZIP is guessed encrypted', async () => {
    const detected = await call(tools, 'detect_format', { path: path.join(workspace, 'secret.zip') });
    assert(detected.encryptedGuess === true, `encryptedGuess ${JSON.stringify(detected.encryptedGuess)}`);
  });

  await checkAsync('diff_archive: added and removed entries are reported', async () => {
    const left = path.join(workspace, 'v1.zip');
    const right = path.join(workspace, 'v2.zip');
    await call(tools, 'create_archive', { archive: left, files: [path.join(tree, 'a.txt')], format: 'zip', overwrite: 'overwrite' });
    await call(tools, 'create_archive', {
      archive: right, files: [path.join(tree, 'a.txt'), path.join(tree, 'sub', 'b.txt')],
      format: 'zip', overwrite: 'overwrite',
    });
    const diff = await call(tools, 'diff_archive', { archive: left, archive2: right });
    assert(diff.counts.added === 1, `added ${diff.counts.added}`);
    assert(diff.counts.removed === 0, `removed ${diff.counts.removed}`);
    assert(diff.note.includes('Size-identical'), 'the size-only caveat is missing');
    const narrowed = await call(tools, 'diff_archive', { archive: left, archive2: right, filter: 'zzz*' });
    assert(narrowed.counts.added === 0, 'the glob filter did not narrow the result');
    const kept = await call(tools, 'diff_archive', { archive: left, archive2: right, filter: 'b.txt' });
    assert(kept.counts.added === 1, `a plain-text filter must act as a substring, kept ${kept.counts.added}`);
  });

  await checkAsync('diff_archive: a missing archive is refused', async () => {
    await assertRejects(
      () => call(tools, 'diff_archive', { archive: path.join(workspace, 'nope.zip'), archive2: path.join(workspace, 'plain.zip') }),
      /Archive not found/,
    );
  });

  await checkAsync('convert_archive: repack changes format and passes its own test', async () => {
    const source = path.join(workspace, 'plain.zip');
    const converted = await call(tools, 'convert_archive', { archive: source, format: '7z', overwrite: 'overwrite' });
    assert(converted.ok === true, `convert failed: ${converted.note ?? ''}`);
    assert(converted.format === '7z', `format ${converted.format}`);
    assert(existsSync(converted.convertedTo), 'no converted archive');
    const detected = await call(tools, 'detect_format', { path: converted.convertedTo });
    assert(detected.format === '7z', `converted file detected as ${detected.format}`);
  });

  await checkAsync('convert_archive: deleteSource removes the source only on success', async () => {
    const source = path.join(workspace, 'to-delete.zip');
    await call(tools, 'create_archive', { archive: source, files: [path.join(tree, 'a.txt')], format: 'zip', overwrite: 'overwrite' });
    const converted = await call(tools, 'convert_archive', {
      archive: source, format: 'tar', overwrite: 'overwrite', deleteSource: true,
    });
    assert(converted.sourceDeleted === true, 'source was not deleted');
    assert(!existsSync(source), 'the source archive survived');
  });

  await checkAsync('extract_archive: destination may not be the archive itself', async () => {
    await assertRejects(() => call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: path.join(workspace, 'plain.zip'), overwrite: 'overwrite',
    }), /must not be the archive itself/);
  });

  await checkAsync('zip-slip: a drive-letter entry rejects the whole archive before writing', async () => {
    // bz's own listing rewrites "../" to "__" and "/x" to "x", so a drive letter is the one
    // traversal shape that survives into the parsed names and can be asserted end to end.
    const slippery = makeZip('slip.zip', [
      { name: 'safe.txt', content: 'fine\n' },
      { name: 'C:/Windows/evil.txt', content: 'should never land\n' },
    ]);
    const target = path.join(workspace, 'slip-out');
    const result = await call(tools, 'extract_archive', { archive: slippery, destination: target, overwrite: 'overwrite' });
    assert(result.ok === false && result.rejected === true, 'a drive-letter entry was accepted');
    assert(/unsafe entry/.test(result.note), `note does not name the guard: ${result.note}`);
    assert(!existsSync(target), 'something was written despite the rejection');
  });

  await checkAsync('zip-slip: bz rewrites "../" away, so the guard is not the one tested here', async () => {
    // Documents the limit rather than pretending: bz l prints "..\\escaped.txt" as
    // "__\\escaped.txt" and then extracts it inside the destination, so the "../" branch
    // of the guard is unreachable through this engine.
    const renamed = makeZip('renamed.zip', [{ name: '../escaped.txt', content: 'x' }]);
    const listed = await call(tools, 'list_archive', { archive: renamed });
    assert(listed.entries.every((entry) => !entry.name.includes('..')), 'bz kept a ".." segment in the name');
  });

  await checkAsync('symlinks: reject refuses the archive, skip drops just the link', async () => {
    const withLink = makeZip('linky.zip', [
      { name: 'real.txt', content: 'real content\n' },
      { name: 'link.txt', content: '../outside.txt', mode: 0o120777 },
    ]);
    const rejected = await call(tools, 'extract_archive', {
      archive: withLink, destination: path.join(workspace, 'link-reject'), overwrite: 'overwrite', symlinks: 'reject',
    });
    assert(rejected.ok === false && rejected.rejected === true, 'the symlink entry was accepted');
    assert(rejected.symlinks.includes('link.txt'), `symlinks listed ${JSON.stringify(rejected.symlinks)}`);
    assert(!existsSync(path.join(workspace, 'link-reject')), 'something was written');

    const skipped = await call(tools, 'extract_archive', {
      archive: withLink, destination: path.join(workspace, 'link-skip'), overwrite: 'overwrite', symlinks: 'skip',
    });
    assert(skipped.ok === true, `skip failed: ${skipped.note ?? ''}`);
    assert(skipped.symlinks.includes('link.txt'), 'the skipped link is not reported');
    assert(skipped.extracted === 1, `extracted ${skipped.extracted} (expected only real.txt)`);
    assert(existsSync(path.join(workspace, 'link-skip', 'real.txt')), 'real.txt did not land');
  });

  await checkAsync('symlinks: a tar typeflag-2 entry is found and rejected', async () => {
    const tarFile = makeTar('linky.tar', { content: 'real content\n', link: { name: 'evil-link', target: '/etc/passwd' } });
    const detected = await call(tools, 'detect_format', { path: tarFile });
    assert(detected.format === 'tar', `detect_format said ${detected.format}`);
    assert(detected.encryptedGuess === false, 'tar should report not-encrypted');
    const rejected = await call(tools, 'extract_archive', {
      archive: tarFile, destination: path.join(workspace, 'tar-reject'), overwrite: 'overwrite',
    });
    assert(rejected.ok === false && rejected.rejected === true, 'the tar symlink was accepted');
    assert(rejected.symlinks.includes('evil-link'), `symlinks listed ${JSON.stringify(rejected.symlinks)}`);
  });

  await checkAsync('symlinks: skip leaves the tar symlink out and extracts the rest', async () => {
    const tarFile = makeTar('linky3.tar', { content: 'real content\n', link: { name: 'evil-link', target: '/etc/passwd' } });
    const target = path.join(workspace, 'tar-skip');
    const skipped = await call(tools, 'extract_archive', {
      archive: tarFile, destination: target, overwrite: 'overwrite', symlinks: 'skip',
    });
    assert(skipped.ok === true, `skip failed: ${skipped.note ?? ''}`);
    assert(skipped.extracted === 1, `extracted ${skipped.extracted}`);
    assert(existsSync(path.join(target, 'real.txt')), 'real.txt did not land');
    assert(skipped.symlinks.includes('evil-link'), 'the skipped link is not reported');
  });

  await checkAsync('symlinks: the rejectSymlinkEntries setting defaults the policy', async () => {
    // With the setting off the pre-flight no longer rejects; bz itself then fails to create a
    // symlink without administrator rights (exit code 2), which is a different failure and is
    // exactly what this asserts: the call got past the guard.
    const permissive = mount({ rejectSymlinkEntries: false }).tools;
    const withLink = makeZip('linky2.zip', [{ name: 'link.txt', content: 'target', mode: 0o120777 }]);
    const result = await call(permissive, 'extract_archive', {
      archive: withLink, destination: path.join(workspace, 'link-allow'), overwrite: 'overwrite',
    });
    assert(result.rejected === false, 'the pre-flight rejected despite the setting');
    assert(!/Refusing to extract/.test(result.note ?? ''), `the guard still refused: ${result.note}`);
  });

  await checkAsync('flat: the symlink pre-check still runs in flat mode', async () => {
    const withLink = makeZip('flat-link.zip', [
      { name: 'ok.txt', content: 'fine\n' },
      { name: 'evil', content: '/etc/passwd', mode: 0o120777 },
    ]);
    const rejected = await call(tools, 'extract_archive', {
      archive: withLink, destination: path.join(workspace, 'flat-link-reject'),
      overwrite: 'overwrite', symlinks: 'reject', flat: true,
    });
    assert(rejected.ok === false && rejected.rejected === true, 'flat mode skipped the symlink guard');
    assert(rejected.symlinks.includes('evil'), `symlinks listed ${JSON.stringify(rejected.symlinks)}`);
    assert(!existsSync(path.join(workspace, 'flat-link-reject')), 'something was written anyway');

    const skipped = await call(tools, 'extract_archive', {
      archive: withLink, destination: path.join(workspace, 'flat-link-skip'),
      overwrite: 'overwrite', symlinks: 'skip', flat: true,
    });
    assert(skipped.ok === true, `flat skip failed: ${skipped.note ?? ''}`);
    assert(skipped.extracted === 1, `extracted ${skipped.extracted}`);
    const landed = readdirSync(path.join(workspace, 'flat-link-skip'));
    assert(landed.length === 1 && landed[0] === 'ok.txt', `flat skip landed ${JSON.stringify(landed)}`);
  });

  await checkAsync('overwrite gate: an existing archive needs the explicit word', async () => {
    const archive = path.join(workspace, 'plain.zip');
    await assertRejects(
      () => call(tools, 'create_archive', { archive, files: [path.join(tree, 'a.txt')], format: 'zip' }),
      /already exists/,
    );
  });

  await checkAsync('overwrite gate: allowArchiveOverwrite:false wins over the argument', async () => {
    const locked = mount({ allowArchiveOverwrite: false }).tools;
    await assertRejects(
      () => call(locked, 'create_archive', {
        archive: path.join(workspace, 'plain.zip'), files: [path.join(tree, 'a.txt')],
        format: 'zip', overwrite: 'overwrite',
      }),
      /allowArchiveOverwrite/,
    );
  });

  await checkAsync('allowPassword:false refuses a password before bz sees it', async () => {
    const locked = mount({ allowPassword: false }).tools;
    await assertRejects(
      () => call(locked, 'list_archive', { archive: path.join(workspace, 'secret.zip'), password: 'pw' }),
      /allowPassword/,
    );
  });

  await checkAsync('restrictToWorkspace:true refuses a path outside the session directory', async () => {
    // The session directory is the workspace; the archive path is a sibling of it.
    const locked = mount({ restrictToWorkspace: true }, workspace).tools;
    await assertRejects(
      () => call(locked, 'list_archive', { archive: path.join(ROOT, 'elsewhere.zip') }),
      /outside the session working directory/,
    );
  });

  await checkAsync('maxExtractBytes: a bomb ceiling rejects the archive before writing', async () => {
    const locked = mount({ maxExtractBytes: 8 }).tools;
    const result = await call(locked, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: path.join(workspace, 'bomb'), overwrite: 'overwrite',
    });
    assert(result.ok === false && result.rejected === true, 'the ceiling did not reject');
    assert(/maxExtractBytes/.test(result.note), 'the message does not name the setting');
    assert(!existsSync(path.join(workspace, 'bomb')), 'something was written');
  });

  await checkAsync('level: an out-of-range value is refused, not clamped', async () => {
    await assertRejects(
      () => call(tools, 'create_archive', { archive: path.join(workspace, 'level.zip'), files: [path.join(tree, 'a.txt')], format: 'zip', level: 42 }),
      /level must be an integer from 0 to 9/,
    );
  });

  await checkAsync('verify: an out-of-contract value is refused', async () => {
    await assertRejects(
      () => call(tools, 'create_archive', {
        archive: path.join(workspace, 'v.zip'), files: [path.join(tree, 'a.txt')], format: 'zip', verify: 'yes',
      }),
      /verify must be/,
    );
  });

  // ── flat extraction ────────────────────────────────────────────────────
  await checkAsync('flat: extract writes every file directly into destination', async () => {
    const target = path.join(workspace, 'flat-out');
    const result = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite', flat: true,
    });
    assert(result.ok === true, `flat extract failed: ${result.note ?? ''}`);
    for (const file of result.entries.map((entry) => entry.landed)) {
      assert(existsSync(file), `${file} did not land`);
      assert(path.dirname(file) === target, `${file} is not directly inside the destination`);
    }
    // No subdirectory may survive the flat extraction.
    const subdirs = readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert(subdirs.length === 0, `flat extract left directories: ${subdirs.map((d) => d.name).join(', ')}`);
  });

  await checkAsync('flat: the archive structure is kept when flat is false', async () => {
    const target = path.join(workspace, 'tree-out');
    const result = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite',
    });
    assert(result.ok === true, `extract failed: ${result.note ?? ''}`);
    const nested = result.entries.filter((entry) => path.dirname(entry.landed) !== target);
    assert(nested.length > 0, 'a non-flat extract produced no nested paths');
  });

  await checkAsync('flat: a name collision follows the overwrite policy', async () => {
    // src/a.txt and lib/a.txt both land as a.txt, so exactly one of them survives.
    const collide = makeZip('collide.zip', [
      { name: 'src/a.txt', content: 'from src\n' },
      { name: 'lib/a.txt', content: 'from lib, which is the longer body\n' },
    ]);
    const target = path.join(workspace, 'collide-out');
    const result = await call(tools, 'extract_archive', {
      archive: collide, destination: target, overwrite: 'overwrite', flat: true,
    });
    assert(result.ok === true, `collision extract failed: ${result.note ?? ''}`);
    const landed = readdirSync(target);
    assert(landed.length === 1 && landed[0] === 'a.txt', `flat collision produced ${JSON.stringify(landed)}`);
  });

  await checkAsync('flat: a second extract reports the files it would overwrite', async () => {
    // Regression: the conflict probe used to look at the non-flat landing path, so a flat
    // extract against a populated destination reported zero conflicts.
    const target = path.join(workspace, 'flat-again');
    const once = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'overwrite', flat: true,
    });
    assert(once.ok === true, `first flat extract failed: ${once.note ?? ''}`);
    assert(once.conflicts.length === 0, 'a first extract into an empty folder reported conflicts');

    const again = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target, overwrite: 'skip', flat: true,
    });
    assert(again.conflicts.length === once.extracted,
      `second flat extract saw ${again.conflicts.length} conflicts, expected ${once.extracted}`);
    assert(again.skipped === once.extracted, `skipped ${again.skipped}, expected ${once.extracted}`);
    for (const conflict of again.conflicts) {
      assert(path.dirname(conflict) === target, `conflict ${conflict} is not a flat landing path`);
    }
  });

  await checkAsync('flat: dryRun counts follow the flat landing paths', async () => {
    const target = path.join(workspace, 'flat-dry');
    const dry = await call(tools, 'extract_archive', {
      archive: path.join(workspace, 'plain.zip'), destination: target,
      overwrite: 'overwrite', flat: true, dryRun: true,
    });
    assert(dry.wouldCreate > 0, `wouldCreate ${dry.wouldCreate}`);
    assert(dry.wouldOverwrite === 0 && dry.wouldSkip === 0, 'an empty destination has nothing to overwrite');
    assert(!existsSync(target), 'dryRun created the destination');
  });

  await checkAsync('flat: colliding entries are counted once, not once per source entry', async () => {
    const collide = makeZip('collide-dry.zip', [
      { name: 'src/a.txt', content: 'from src\n' },
      { name: 'lib/a.txt', content: 'from lib\n' },
    ]);
    const target = path.join(workspace, 'collide-dry-out');
    const dry = await call(tools, 'extract_archive', {
      archive: collide, destination: target, overwrite: 'overwrite', flat: true, dryRun: true,
    });
    assert(dry.wouldCreate === 1,
      `two entries landing on a.txt were counted as ${dry.wouldCreate} files`);
  });

  // ── shallow packing ────────────────────────────────────────────────────
  await checkAsync('recursive:false packs only the top-level files of a folder', async () => {
    const archive = path.join(workspace, 'shallow.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'sub')], format: 'zip', overwrite: 'overwrite', recursive: false,
    });
    assert(created.ok === true, `shallow create failed: ${created.note ?? ''}`);
    const listed = await call(tools, 'list_archive', { archive });
    const names = listed.entries.filter((entry) => !entry.isDir).map((entry) => entry.name);
    assert(names.length === 1, `expected one file, got ${JSON.stringify(names)}`);
    assert(names[0].endsWith('b.txt'), `expected sub/b.txt, got ${names[0]}`);
    assert(!names.some((name) => name.includes('deep')), `a nested file leaked in: ${names.join(', ')}`);
  });

  await checkAsync('recursive:true (the default) keeps the whole subtree', async () => {
    const archive = path.join(workspace, 'deep.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'sub')], format: 'zip', overwrite: 'overwrite',
    });
    assert(created.ok === true, 'default create failed');
    const listed = await call(tools, 'list_archive', { archive });
    const names = listed.entries.filter((entry) => !entry.isDir).map((entry) => entry.name);
    assert(names.length === 2, `expected two files, got ${JSON.stringify(names)}`);
    assert(names.some((name) => name.includes('deep')), 'the nested file is missing');
  });

  await checkAsync('recursive:false skips an empty folder and says so', async () => {
    const archive = path.join(workspace, 'empty-skip.zip');
    const created = await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'sub'), path.join(tree, 'empty')], format: 'zip',
      overwrite: 'overwrite', recursive: false,
    });
    assert(created.ok === true, `create failed: ${created.note ?? ''}`);
    assert(/skipped empty director/.test(created.note ?? ''), `the skip is not reported: ${created.note}`);
  });

  await checkAsync('recursive:false with nothing left to pack is an error', async () => {
    await assertRejects(
      () => call(tools, 'create_archive', {
        archive: path.join(workspace, 'empty-only.zip'), files: [path.join(tree, 'empty')],
        format: 'zip', overwrite: 'overwrite', recursive: false,
      }),
      /every source was an empty directory/,
    );
  });

  await checkAsync('recursive:false treats "only empty subfolders" as empty too', async () => {
    // The shallow check asks "does this folder hold a top-level FILE", not "does it hold
    // any entry". A folder with nothing but empty subfolders used to be handed to bz as
    // "dir/*", which failed with "No files to archive" after the tool had already
    // reported success.
    const nested = path.join(workspace, 'nested-empty');
    mkdirSync(path.join(nested, 'inner'), { recursive: true });
    await assertRejects(
      () => call(tools, 'create_archive', {
        archive: path.join(workspace, 'nested-empty.zip'), files: [nested],
        format: 'zip', overwrite: 'overwrite', recursive: false,
      }),
      /every source was an empty directory/,
    );
  });

  await checkAsync('recursive:false together with include/exclude is refused, not guessed', async () => {
    await assertRejects(
      () => call(tools, 'create_archive', {
        archive: path.join(workspace, 'ambiguous.zip'), files: [path.join(tree, 'sub')],
        format: 'zip', overwrite: 'overwrite', recursive: false, include: ['**/*.txt'],
      }),
      /cannot be combined with include or exclude/,
    );
    await assertRejects(
      () => call(tools, 'create_archive', {
        archive: path.join(workspace, 'ambiguous2.zip'), files: [path.join(tree, 'sub')],
        format: 'zip', overwrite: 'overwrite', recursive: false, exclude: ['**/*.log'],
      }),
      /cannot be combined with include or exclude/,
    );
  });

  // ── listing statistics ─────────────────────────────────────────────────
  await checkAsync('stats:true returns the four aggregates with correct numbers', async () => {
    const archive = path.join(workspace, 'stats.zip');
    await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'a.txt'), path.join(tree, 'sub', 'b.txt')],
      format: 'zip', overwrite: 'overwrite',
    });
    const listed = await call(tools, 'list_archive', { archive, stats: true });
    assert(Array.isArray(listed.byExtension), 'byExtension is not an array');
    assert(Array.isArray(listed.topLevelDirs), 'topLevelDirs is not an array');
    assert(Array.isArray(listed.largest), 'largest is not an array');

    const aSize = statSync(path.join(tree, 'a.txt')).size;
    const bSize = statSync(path.join(tree, 'sub', 'b.txt')).size;
    assert(listed.totalUncompressedBytes === aSize + bSize,
      `totalUncompressedBytes ${listed.totalUncompressedBytes} != ${aSize + bSize}`);

    const txt = listed.byExtension.find((entry) => entry.extension === '.txt');
    assert(txt !== undefined, 'no .txt bucket');
    assert(txt.count === 2 && txt.bytes === aSize + bSize,
      `.txt bucket is ${JSON.stringify(txt)}, expected count 2 and ${aSize + bSize} bytes`);

    assert(listed.topLevelDirs.length === 1, `topLevelDirs ${JSON.stringify(listed.topLevelDirs)}`);
    assert(listed.topLevelDirs[0].uncompressedBytes === aSize + bSize, 'topLevelDirs bytes are wrong');

    assert(listed.largest.length === 2, `largest holds ${listed.largest.length} entries`);
    assert(listed.largest[0].size >= listed.largest[1].size, 'largest is not sorted by size');
  });

  await checkAsync('stats: the fields are absent unless stats:true is passed', async () => {
    const listed = await call(tools, 'list_archive', { archive: path.join(workspace, 'plain.zip') });
    for (const field of ['byExtension', 'topLevelDirs', 'largest']) {
      assert(!Object.hasOwn(listed, field), `${field} appeared without stats:true`);
    }
  });

  await checkAsync('stats: the aggregates describe the whole archive, not the current page', async () => {
    const archive = path.join(workspace, 'paged.zip');
    await call(tools, 'create_archive', {
      archive, files: [path.join(tree, 'a.txt'), path.join(tree, 'sub', 'b.txt'), path.join(tree, 'sub', 'deep', 'c.txt')],
      format: 'zip', overwrite: 'overwrite',
    });
    const paged = await call(tools, 'list_archive', { archive, stats: true, limit: 1, offset: 0 });
    const full = await call(tools, 'list_archive', { archive, stats: true });
    assert(paged.entries.length === 1, 'the page was not limited');
    assert(paged.totalUncompressedBytes === full.totalUncompressedBytes,
      'the aggregate changed with the page, so it describes the page');
    const pagedTxt = paged.byExtension.find((entry) => entry.extension === '.txt');
    assert(pagedTxt !== undefined && pagedTxt.count === 3, `page-relative bucket ${JSON.stringify(pagedTxt)}`);
  });

  await checkAsync('output: every answer only uses fields its own schema declares', async () => {
    const cases = [
      ['list_archive', { archive: path.join(workspace, 'plain.zip') }],
      ['check_archive', { archive: path.join(workspace, 'plain.zip') }],
      ['detect_format', { path: path.join(workspace, 'plain.zip') }],
      ['diff_archive', { archive: path.join(workspace, 'v1.zip'), archive2: path.join(workspace, 'v2.zip') }],
      ['extract_archive', { archive: path.join(workspace, 'plain.zip'), destination: path.join(workspace, 'schema-out'), overwrite: 'overwrite', dryRun: true }],
      ['create_archive', { archive: path.join(workspace, 'schema.zip'), files: [path.join(tree, 'a.txt')], format: 'zip', overwrite: 'overwrite', verify: true }],
      ['compress_file', { file: path.join(tree, 'a.txt'), format: 'zstd', overwrite: true }],
      ['decompress_file', { file: path.join(workspace, 'schema-check.zst'), overwrite: true }],
      ['convert_archive', { archive: path.join(workspace, 'plain.zip'), format: 'tar', overwrite: 'overwrite' }],
    ];
    // decompress_file needs a real stream to expand, so make one before the loop runs.
    await call(tools, 'compress_file', {
      file: path.join(tree, 'a.txt'), format: 'zstd', destination: path.join(workspace, 'schema-check.zst'),
      overwrite: true,
    });
    for (const [name, args] of cases) {
      const value = await call(tools, name, args);
      const declared = new Set(Object.keys(tools.get(name).output.schema.properties));
      const extra = Object.keys(value).filter((key) => !declared.has(key));
      assert(extra.length === 0, `${name} returned undeclared field(s): ${extra.join(', ')}`);
      for (const field of tools.get(name).output.schema.required) {
        assert(Object.hasOwn(value, field), `${name} omitted required field ${field}`);
      }
    }
  });

  await checkAsync('convert_archive: the target may not be the source', async () => {
    await assertRejects(
      () => call(tools, 'convert_archive', {
        archive: path.join(workspace, 'plain.zip'), destination: path.join(workspace, 'plain.zip'),
      }),
      /equals the source archive/,
    );
  });
}

// ── report ──────────────────────────────────────────────────────────────
try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  // best effort: a leftover temp tree must not fail the run
}

console.log(log.join('\n'));
console.log('');
console.log(failures === 0 ? `ALL PASS (${passes} checks)` : `${failures} FAILURE(S) of ${passes + failures} checks`);
process.exit(failures === 0 ? 0 : 1);
