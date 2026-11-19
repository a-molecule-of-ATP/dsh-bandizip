# Bandizip archives: packing and unpacking through bz.exe

![A stack of files zipped into an archive](preview.svg)

> **Terminology**
> - **Arguments** are passed by the agent on every call and declared in the tool schema, such as `level`, `overwrite`, `include`, and `timeoutSeconds`.
> - **Settings** are configured by you on the plugin page and apply across calls, usually permissions or environment, such as `allowArchiveOverwrite`, `restrictToWorkspace`, `allowPassword`, `bzPath`, `maxExtractBytes`, `rejectSymlinkEntries`, and `timeoutSeconds` (as a cap).
> - **Command-line switches** belong to `bz.exe` itself, such as `-aoa`, `-o:`, and `-r-`; do not confuse them with the other two.

## What it solves

An agent handling archives could compose a `bz.exe` command line itself, but the
command-line switches carry traps: `-o:` must precede the archive, `x` and `e`
differ in whether the directory structure survives, a missing overwrite
command-line switch (`-ao*`) parks the process on an interactive prompt, and exit
code 1 can mean either a warning or a failure. This plugin folds those details into one tool, so the agent only has to
say what it wants.

## The eight actions

| action | Does | Key arguments |
|---|---|---|
| `create` | Build a new archive | `files`, `format`, `level`, `include` (glob), `mode` (`create` / `append`), `password` |
| `extract` | Unpack into a folder, after three pre-write guards | `destination`, `include` / `exclude` (archive masks), `overwrite`, `flat`, `dryRun` |
| `list` | List entries, filtered and paged | `filter`, `limit`, `offset`, `encoding` |
| `test` | Verify entry data and passwords with `bz t` | `password` |
| `preview` | Inspect without extracting, aggregate view | the `list` arguments |
| `diff` | Compare two archives | `archive2` |
| `browse` | Walk the archive one level at a time | `path`, `depth` |
| `convert` | Repack into another format, level or password | `format`, `level`, `password`, `newPassword`, `deleteSource` |

## How masks match

An `include` / `exclude` mask is a path relative to the archive root, and `*`
covers exactly one level. All three cases below report success — including the
one that matches nothing. **The plugin only reads bz's exit code and does not
detect an empty match for you, so check the returned entry count yourself:**

![What each mask matches](masks.svg)

## Examples

Inspect an archive without writing anything:

```json
{"action": "preview", "archive": "release.zip"}
```

Extract only the subset you need (masks are relative to the archive root and use
backslashes):

```json
{"action": "extract", "archive": "assets.zip", "destination": "out", "include": ["assets\\scene\\*.js"]}
```

See what a real extract would collide with before running it:

```json
{"action": "extract", "archive": "assets.zip", "destination": "out", "dryRun": true}
```

Pack by glob and verify the result:

```json
{"action": "create", "archive": "src.zip", "files": ["."], "include": ["**/*.ts"], "verify": true}
```

Compare two releases:

```json
{"action": "diff", "archive": "v1.zip", "archive2": "v2.zip"}
```

## Every behaviour is decided per call

### Arguments versus settings

The "Default" column below is the schema default an **argument** takes when the
call omits it; the agent supplies or omits it on each call. **Settings**, by
contrast, are configured by you on the plugin page and apply across calls
(permissions and environment such as `allowArchiveOverwrite`,
`restrictToWorkspace`, `allowPassword`, and `bzPath`). Changing an argument
affects only that call; changing a setting affects every later call. Pass another
value when the task needs one:

| Argument | Default |
|---|---|
| `level` | `5` (0 stores only, 9 is smallest) |
| `recursive` | `true` |
| `overwrite` | `overwrite` (replace same-named files on extract) |
| `flat` | `false` (keep the directory structure) |
| `destination` | a folder beside the archive, named after it |
| `mode` | `create` |
| `encoding` | `auto` (fall back from UTF-8 to GBK) |
| `timeoutSeconds` | this is an **argument**: it defaults to the `timeoutSeconds` setting (schema default 900 s); a per-call value takes priority |

## Safety and boundaries

- **Passwords travel as command-line switches**, so other processes on this
  machine can read them in the process list. Turn `allowPassword` off on the
  plugin page when the capability is not needed.
- **create never replaces an existing archive** unless two gates both open:
  `allowArchiveOverwrite` must be on, and the call must pass
  `overwrite: "overwrite"` explicitly.
- **`restrictToWorkspace`** confines `archive`, `files` and `destination` to the
  session working directory.
- **Three guards run before extract writes anything.** Each returns `ok:false` with
  `rejected:true`, and any one failure rejects the whole archive:
  - **zip-slip**: an entry naming `..`, an absolute path or a drive letter is
    rejected and the offending entry is reported.
  - **compressed-bomb ceiling** (`maxExtractBytes`): the extracted sizes the entries
    *declare* are summed, and the archive is rejected when the total exceeds the
    ceiling; `0` disables the check. Those sizes come from the archive's own
    headers, so a hostile archive can understate them — this is a cheap early stop,
    not proof.
  - **symlink entries** (`rejectSymlinkEntries`, on by default): a symlink can
    redirect later writes outside the destination. `bz l`'s attribute column carries
    only the directory flag and the DOS archive bit, so a symlink entry prints
    exactly like a regular file; the plugin therefore reads the Unix mode bits in
    the ZIP central directory itself. **Only zip / zipx are covered** — 7z, tar and
    other formats, plus ZIP64 central directories, are not scanned, and there the
    setting does not apply rather than "confirmed clean".
- **`dryRun` also sits behind those three guards**: it runs after them, so it too
  rejects the archive on a path escape, an over-budget total or a symlink entry.
- **`convert` needs double the disk**: it unpacks into a temporary directory and
  repacks, so check free space for large archives.

## Known limits

- **`diff` compares name and size only** — a change that keeps the size is
  invisible, and the output says so.
- **Encrypted archives cannot be listed** unless a `password` is supplied: a 7z
  archive asks for the password at the `list` stage, so `preview` and `diff` have no
  data to work on without one.
- **No repair, no mounting**: `bz.exe` is a console compressor, so a damaged
  archive can only be salvaged, and mounting belongs to the GUI product.
- **The symlink guard covers zip / zipx only**: `bz l` does not report entry types
  for 7z, tar and other formats, and this plugin does not guess; ZIP64 central
  directories are skipped as well. In those cases `rejectSymlinkEntries` does not
  apply — do not read its silence as "confirmed no symlinks".
- **Relative paths resolve against the session working directory**, not the
  plugin directory.

## How this differs from comparable projects

These are observations from one round of sampling across archive-oriented MCP
servers and plugins. **Wherever something was "not found in our sample", it is
written that way** — it does not mean the wider ecosystem lacks it.

- **One tool with eight actions, not one tool per action.** The archive projects we
  sampled mostly cover only create / list / extract, and tend to register a separate
  tool per action (some reach a dozen or more). Here everything is dispatched by one
  `bandizip` tool through an `action` argument: one extra line in the tool list, and
  one parameter schema to maintain.
- **Settings hold only permissions, environment facts and hard ceilings; behaviour
  details are passed per call.** None of the nine settings is a behaviour preference
  such as "default compression level" or "default recursion" — level, recursive,
  overwrite, flat, mode, encoding and destination are supplied on every call. The
  settings answer three questions only: whether the capability is allowed
  (`enabled`, `allowPassword`, `allowArchiveOverwrite`), which executable runs it
  (`bzPath`), and what the hard limits are (`timeoutSeconds`, `maxOutputChars`,
  `maxExtractBytes`, `rejectSymlinkEntries`, `restrictToWorkspace`). Within our
  sample, we did not find a second project that states this as an explicit design
  principle.
- **`test` runs the real `bz t`, and extract has three pre-write guards.** `bz l`
  reads the central directory alone and reports a damaged data section as fine, so
  `test` verifies entries with `bz t` instead. `extract` runs zip-slip, the
  compressed-bomb ceiling and the symlink check before writing and rejects the whole
  archive on any failure. Within our sample, the only project that explicitly offers
  "verify without extracting" is `zipnative-mcp`; we did not find a second one that
  has all three pre-extract guards.
- **`diff` and `convert` exist here.** Within our sample, no project explicitly
  offers entry-by-entry comparison of two archives (`diff`) or repacking into another
  format, level or password (`convert`). Both are ordinary actions here, and both
  state their own caveat: `diff` says outright that it compares name and size only,
  and `convert` verifies its output with `bz t` and deletes the source only when
  `deleteSource` is set and the conversion succeeded.

The closest project in form is `zv-louis/mcp7zop`, which likewise wraps a local 7-Zip
command line. One more reference point: the official MCP `filesystem` server already
has realpath resolution and allowed directories, yet public records still show path
traversal and TOCTOU issues against it — sandboxed path access is a surface that keeps
producing bugs rather than something one setting permanently fixes.

> Sampling caveat: every "not found" above is scoped to this one round (mostly
> relayed by a research agent; project pages were spot-checked for existence, and the
> CVE / GHSA identifiers were not individually verified). Comparisons like this age
> quickly — treat them as an observation at the time of writing.
