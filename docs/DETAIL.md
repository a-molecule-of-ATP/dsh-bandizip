# Bandizip archives: packing and unpacking through bz.exe

![A stack of files zipped into an archive](preview.svg)

> **Terminology**
> - **Arguments** are passed by the agent on every call and declared in the tool schema, such as `level`, `overwrite`, `include`, and `timeoutSeconds`.
> - **Settings** are configured by you on the plugin page and apply across calls, usually permissions or environment, such as `allowArchiveOverwrite`, `restrictToWorkspace`, `allowPassword`, `bzPath`, `maxExtractBytes`, `rejectSymlinkEntries`, and `timeoutSeconds` (as a cap).
> - **Command-line switches** belong to `bz.exe` itself, such as `-aoa`, `-o:`, and `-r-`; do not confuse them with the other two.

## What it solves

An agent handling archives could compose a `bz.exe` command line itself, but the command-line switches carry traps: `-o:` must precede the archive, `x` and `e` differ in whether the directory structure survives, a missing overwrite command-line switch (`-ao*`) parks the process on an interactive prompt, and exit code 1 can mean either a warning or a failure. This plugin folds those details into its tools, so the agent only has to say what it wants.

Since 0.3.0 it is no longer one tool with an `action` enum but **nine semantic tools**: each declares only the arguments it reads, and each has its own output schema.

## The nine tools

| Tool | Does | Key arguments |
|---|---|---|
| `list_archive` | List entries, and answer "is it encrypted" and "is it split" | `filter`, `limit` / `offset`, `encoding`, `stats`, `password` |
| `extract_archive` | Unpack into a folder, after three pre-write guards | `destination`, `overwrite` (required), `include` / `exclude`, `dryRun`, `symlinks`, `checksum`, `flat` |
| `create_archive` | Pack / append / split / encrypt | `files`, `format`, `level`, `include` / `exclude`, `mode`, `volumeSize`, `verify`, `recursive` |
| `compress_file` | Compress one file to gz / xz / zstd | `file`, `format`, `level`, `destination`, `overwrite` |
| `decompress_file` | Expand a gz / xz / zstd file | `file`, `format` (optional), `destination`, `overwrite` |
| `check_archive` | Verify entry data and passwords with `bz t` | `password`, `checksum` |
| `detect_format` | Identify a format by **magic bytes** | `path` |
| `diff_archive` | Compare two archives | `archive2`, `filter` (substring or glob) |
| `convert_archive` | Repack into another format, level or password | `format`, `level`, `password`, `newPassword`, `deleteSource`, `destination` |

### Format identification (`detect_format`)

The old behaviour guessed from the extension and failed when it could not — a renamed archive or a download with no suffix hit exactly that. It now reads **magic bytes**:

| Format | Where |
|---|---|
| ZIP | offset 0: `50 4B 03 04` / `05 06` / `07 08` |
| 7z | offset 0: `37 7A BC AF 27 1C` |
| RAR | offset 0: `52 61 72 21 1A 07` |
| GZIP | offset 0: `1F 8B` |
| XZ | offset 0: `FD 37 7A 58 5A 00` |
| BZIP2 | offset 0: `42 5A 68` |
| ZSTD | offset 0: `28 B5 2F FD` |
| LZH | offset 2: `-lh` (LZH has no leading signature) |
| TAR | offset 257: `ustar` |
| ISO | offset 0x8001: `CD001` |
| CAB | offset 0: `MSCF` |
| Self-extracting exe | offset 0: `MZ` |

When no signature matches it falls back in order: a `bz l` run parsed for the `Archive format:` line → the extension (with `isArchive: false`, because the bytes did not back the answer) → `format: "unknown"`, which is an **answer**, not an error.

### Encryption detection (`list_archive` / `detect_format`)

`bz l` never marks encryption: verified against bz 7.47, an archive built with `-p:123` still shows `A___` in its Attr column. So each format is asked the only way it can answer:

- **ZIP / ZIPX**: the plugin's own central-directory parser reads **bit 0** of the general-purpose bit flag, which also yields the encrypted entry count.
- **7z / RAR / LZH / CAB**: no header is parsed here, so the probe is **one password-less `bz t`** — a password error means encrypted, a clean pass means not. Each probe costs a full read, so the verdict is cached per path + size + mtime.
- **tar and gz/xz/bzip2/zstd/iso**: no encryption concept, so `false`.
- **A failed probe never throws**: the answer is `encrypted: 'unknown'`, and `note` carries both the provenance (`zip-central-directory` / `bz-test-trial` / `format-cannot-encrypt`) and the reason it could not answer.

### Split volumes (`list_archive`)

A split ZIP lives on disk as sibling files: `xxx.z01`, `xxx.z02`, … plus the final `xxx.zip`. The `.zip` carries no record of being one fragment, so the sibling files are what the tool counts; `parts` includes the `.zip` itself.

### Three views: list, aggregate, flatten

- **`stats:true` on `list_archive`** adds three aggregates: `byExtension` (extension -> `{ count, bytes }`), `topLevelDirs` (top-level name -> `{ entryCount, uncompressedBytes }`) and `largest` (the ten biggest `name` + `size`). All are computed from the entries already parsed, with no second `bz` call. **They describe the whole archive**: passing `limit` / `offset` / `filter` does not narrow them, because the field names promise "what is in this archive", not "what this request saw".
- **`flat:true` on `extract_archive`** uses `e` instead of `x`, so every file lands directly in the destination and `entries[].landed` follows suit. Combined with `include` / `exclude` the per-entry extraction switches to `e` as well; the symlink pre-check is unaffected, because only the extraction command changed.
- **`recursive:false` on `create_archive`** packs only the top-level files of each folder (`-r-` plus a `dir/*` entry). Empty folders are skipped and named in `note`; when every source is empty it is an error. It **cannot** be combined with `include` / `exclude`: the two select files by different rules, and the plugin reports the conflict instead of ranking them for you.

## How masks match

An `include` / `exclude` mask is a path relative to the archive root, and `*` covers exactly one level. All three cases below report success — including the one that matches nothing. **The plugin only reads bz's exit code and does not detect an empty match for you, so check the returned entry count yourself:**

![What each mask matches](masks.svg)

## Examples

List what an archive holds without extracting:

```json
{"archive": "release.zip", "filter": "src/"}
```

Extract only the subset you need (masks are relative to the archive root and use backslashes):

```json
{"archive": "assets.zip", "destination": "out", "overwrite": "overwrite", "include": ["assets\\\\scene\\\\*.js"]}
```

See what a real extract would collide with before running it:

```json
{"archive": "assets.zip", "destination": "out", "overwrite": "skip", "dryRun": true}
```

Pack by glob and verify the result:

```json
{"archive": "src.zip", "files": ["."], "include": ["**/*.ts"], "verify": "roundtrip"}
```

Compress a log file (zstd needs Node >= 22.15):

```json
{"file": "access.log", "format": "zstd", "level": 9}
```

Compare two releases:

```json
{"archive": "v1.zip", "archive2": "v2.zip"}
```

## Every behaviour is decided per call

### Arguments versus settings

The "Default" column below is the schema default an **argument** takes when the call omits it; the agent supplies or omits it on each call. **Settings**, by contrast, are configured by you on the plugin page and apply across calls (permissions and environment such as `allowArchiveOverwrite`, `restrictToWorkspace`, `allowPassword`, and `bzPath`). Changing an argument affects only that call; changing a setting affects every later call. Pass another value when the task needs one:

| Argument | Default |
|---|---|
| `level` | `5` (0 stores only, 9 is smallest) |
| `overwrite` (extract) | **none**: `overwrite` / `skip` / `rename` must be given |
| `overwrite` (create / convert) | none: only `"overwrite"` unlocks replacing an existing archive |
| `overwrite` (compress / decompress) | `false` (an existing output file is kept) |
| `destination` (extract) | **none**: the landing folder must be given |
| `destination` (compress / decompress / convert) | derived from the source name |
| `mode` | `create` |
| `recursive` | `true` (`false` packs top-level files only) |
| `flat` | `false` (keep the directory structure) |
| `stats` | `false` (`true` adds the three aggregates) |
| `symlinks` | follows the `rejectSymlinkEntries` setting (`true` by default → `reject`) |
| `volumeSize` | none (no splitting) |
| `encoding` | `auto` (fall back from UTF-8 to GBK) |
| `timeoutSeconds` | this is an **argument**: it defaults to the `timeoutSeconds` setting (schema default 900 s); a per-call value takes priority |

### Parameter scope is a hard boundary

The host does not validate arguments against `parameters` on this path, so each tool's `execute` checks the argument names and the required ones first: a field belonging to another tool (passing `dryRun` to `list_archive`, say) is rejected with the list of what that tool actually takes, and a missing required argument (say `destination` on `extract_archive`) is rejected on the spot instead of degrading into a `<cwd>/undefined` call that looks successful. The parameter objects declare `additionalProperties: false` as well, so the schema refuses extras too.

## Safety and boundaries

- **Passwords travel as command-line switches**, so other processes on this machine can read them in the process list. Turn `allowPassword` off on the plugin page when the capability is not needed.
- **create / convert never replace an existing archive** unless two gates both open: `allowArchiveOverwrite` must be on, and the call must pass `overwrite: "overwrite"` explicitly.
- **`restrictToWorkspace`** confines `archive`, `files` and `destination` to the session working directory.
- **Three guards run before extract writes anything.** Each returns `ok:false` with `rejected:true`, and any one failure rejects the whole archive:
  - **zip-slip**: an entry naming `..`, an absolute path or a drive letter is rejected and the offending entry is reported.
  - **compressed-bomb ceiling** (`maxExtractBytes`): the extracted sizes the entries *declare* are summed, and the archive is rejected when the total exceeds the ceiling; `0` disables the check. Those sizes come from the archive's own headers, so a hostile archive can understate them — this is a cheap early stop, not proof.
  - **symlink entries** (`symlinks`, defaulting to the `rejectSymlinkEntries` setting): a symlink can redirect later writes outside the destination. `bz l`'s attribute column carries only the directory flag and the DOS archive bit, so a symlink entry prints exactly like a regular file; the plugin therefore reads the Unix mode bits in the **ZIP central directory** and the tar header **typeflag `'2'`**. **7z and other formats are not covered** — there the check does not apply rather than "confirmed clean". Three policies: `reject` refuses the archive, `skip` drops just the links and extracts the rest, `allow` takes them as-is.
- **`checksum` can stop a wrong archive before extraction**: when `extract_archive` is given one, the archive's own digest is verified first and a mismatch rejects the call without writing a byte.
- **`dryRun` also sits behind those three guards**: it runs after them, so it too rejects the archive on a path escape, an over-budget total or a symlink entry.
- **`convert_archive` needs double the disk**: it unpacks into a temporary directory and repacks, so check free space for large archives.

## Known limits

- **`diff_archive` compares name and size only** — a change that keeps the size is invisible, and the output says so.
- **Encrypted archives cannot be listed** unless a `password` is supplied: a 7z archive asks for the password at the listing stage, `list_archive` reports `ok:false` with a note explaining why, and passing `password` is what makes the entries visible.
- **No repair, no mounting**: `bz.exe` is a console compressor, so a damaged archive can only be salvaged, and mounting belongs to the GUI product.
- **The symlink guard covers zip / zipx / tar only**: `bz l` does not report entry types for 7z and other formats, and this plugin does not guess; ZIP64 and central directories over 4 MB are skipped as well. In those cases the check does not apply — do not read its silence as "confirmed no symlinks".
- **A large central directory is skipped**: reading it into memory is the one place this plugin loads a whole structure, so there is a 4 MB ceiling, and going over it skips the encryption / symlink probe with a note instead of guessing.
- **Encryption for compiled formats is a probe**: when a password-less `bz t` on a 7z / RAR fails without mentioning a password (a damaged archive, say), the answer is `'unknown'` rather than a guess.
- **The gzip payload is told apart by name**: `1F 8B` only says "gzip"; `tgz` is reported when the file name ends in `.tar.gz` / `.tgz`.
- **Relative paths resolve against the session working directory**, not the plugin directory.

## Migrating from 0.2.x

0.3.0 is a **breaking change**: every `bandizip {action: …}` call stops working, and there is no compatibility entry point. The full table lives in the README's migration section; the easiest traps are:

- `extract` → `extract_archive`, where `destination` and `overwrite` are now **required**.
- `preview` and `browse` are gone as actions: compute what `preview` aggregated from `list_archive`'s `entries`, and use `list_archive` + `filter` for a prefix walk.
- `create`'s `recursive` is gone (packing is always recursive) and so is its `encoding` (it does not decode entry names).
- Single-file compression moved from `create -fmt:gz` to `compress_file` / `decompress_file`, and **zstd is new**.
- Format identification moved from "guess the extension, fail otherwise" to `detect_format` reading **magic bytes**.

## How this differs from comparable projects

Archive tooling splits into two camps: built for agents, and built for people.

The DSH ecosystem already has an agent-facing archive plugin — `yuehancn/dsh-tool-archive`: four tools (`archive_pack`, `archive_unpack`, `archive_status`, `archive_verify`), a tar format it reads and writes itself, no external dependency, deterministic packing, a per-member refusal to write outside the destination, and SHA-256 verification of what came out. On the MCP side there is `zipnative-mcp` (a dozen typed tools, traversal/symlink/bomb guards on by default) and `zv-louis/mcp7zop` (a wrapper around a local 7-Zip CLI).

What those share is an **engine of their own** — either implementing the format or shipping a compression stack. This plugin takes the other road: **no new engine; it connects the Bandizip already installed on the machine to the agent's tool surface.**

| | `dsh-tool-archive` | This plugin |
|---|---|---|
| Engine | tar, implemented in the plugin | the local `bz.exe` (gz / zstd via `node:zlib`) |
| Formats | tar | zip / zipx / 7z / iso / exe / lzh / tar family, plus gz / xz / zstd streams |
| Determinism, checksum | a strength (deterministic tar + SHA-256) | none (integrity via `bz t`, plus the artifact's sha256) |
| Runtime | zero dependency, cross-platform | Windows + Bandizip installed |
| Tool shape | 4 tools | 9 semantic tools |

The remaining points are differences against the MCP group:

1. **One semantic tool per action, not one tool carrying eight actions.** Most sampled projects stop at create / list / extract and tend to register a separate tool for each; here they are split the same way — each argument has one owner, and each tool has one output schema instead of a union of thirty-odd fields.
2. **Capabilities are split by *object*, not by *action*.** `compress_file` / `decompress_file` handle a single stream, `*_archive` handles a container, `detect_format` handles any file. Folded into one action enum, `format` had to be explained three different ways.
3. **Settings keep only permissions, environment facts and ceilings.** None of the nine is a behaviour preference such as a default compression level — level, overwrite, mode, encoding and destination are all passed per call. What remains answers three questions: what may be used, what it points at, and the hard ceilings.
4. **Three guards before anything is written.** zip-slip, a declared-size ceiling and symlink entries; failing any one refuses the whole archive, and `symlinks` lets the caller pick "refuse / drop the links / allow" per call. **These are not unique to this plugin** — `zipnative-mcp` and `dsh-tool-archive` have guards of their own — the difference is that here they sit in front of one machine's multi-format engine.
5. **`diff_archive` and `convert_archive` were not found among comparable projects in the sample.** Both stay as their own tools: `diff_archive` states plainly that it compares by name and size only, and `convert_archive` verifies the result with `bz t` and deletes the source only after success.

> Sampling note: "not found" means not found in this round of sampling (project pages were checked for existence; CVE / GHSA identifiers were not verified one by one). Comparisons age; read this as an observation at the time of writing.
