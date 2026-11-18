# Bandizip archives: packing and unpacking through bz.exe

![A stack of files zipped into an archive](preview.svg)

## What it solves

An agent handling archives could compose a `bz.exe` command line itself, but the
switches carry traps: `-o:` must precede the archive, `x` and `e` differ in
whether the directory structure survives, a missing overwrite switch parks the
process on an interactive prompt, and exit code 1 can mean either a warning or a
failure. This plugin folds those details into one tool, so the agent only has to
say what it wants.

## The eight actions

| action | Does | Key arguments |
|---|---|---|
| `create` | Build a new archive | `files`, `format`, `level`, `include` (glob), `mode` (`create` / `append`), `password` |
| `extract` | Unpack into a folder | `destination`, `include` / `exclude` (archive masks), `overwrite`, `flat`, `dryRun` |
| `list` | List entries, filtered and paged | `filter`, `limit`, `offset`, `encoding` |
| `test` | Verify integrity and passwords | `password` |
| `preview` | Inspect without extracting, aggregate view | the `list` arguments |
| `diff` | Compare two archives | `archive2` |
| `browse` | Walk the archive one level at a time | `path`, `depth` |
| `convert` | Repack into another format, level or password | `format`, `level`, `password`, `newPassword`, `deleteSource` |

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

These are argument defaults, not plugin settings — pass another value when the
task needs one:

| Argument | Default |
|---|---|
| `level` | `5` (0 stores only, 9 is smallest) |
| `recursive` | `true` |
| `overwrite` | `overwrite` (replace same-named files on extract) |
| `flat` | `false` (keep the directory structure) |
| `destination` | a folder beside the archive, named after it |
| `mode` | `create` |
| `encoding` | `auto` (fall back from UTF-8 to GBK) |
| `timeoutSeconds` | the configured value, 900 by default |

## Safety and boundaries

- **Passwords travel as command-line switches**, so other processes on this
  machine can read them in the process list. Turn `allowPassword` off on the
  plugin page when the capability is not needed.
- **create never replaces an existing archive** unless two gates both open:
  `allowArchiveOverwrite` must be on, and the call must pass
  `overwrite: "overwrite"` explicitly.
- **`restrictToWorkspace`** confines `archive`, `files` and `destination` to the
  session working directory.
- **`dryRun` also refuses path escapes**: an entry naming `..`, an absolute path
  or a drive letter rejects the whole archive and reports the offending entry.
- **`convert` needs double the disk**: it unpacks into a temporary directory and
  repacks, so check free space for large archives.

## Known limits

- **`diff` compares name and size only** — a change that keeps the size is
  invisible, and the output says so.
- **Encrypted archives cannot be listed**: a 7z archive asks for the password at
  the `list` stage, so `preview` and `diff` have no data to work on.
- **No repair, no mounting**: `bz.exe` is a console compressor, so a damaged
  archive can only be salvaged, and mounting belongs to the GUI product.
- **Relative paths resolve against the session working directory**, not the
  plugin directory.
