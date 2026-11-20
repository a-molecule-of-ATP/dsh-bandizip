# Bandizip 插件（dsh-bandizip）

一个让 DeepSeek Harness 智能体调用本机 Bandizip 控制台程序（`bz.exe`）来处理压缩包的 DSH 插件：列目录、解压、打包、单文件压缩/解压、校验、格式识别、比较、转换。**只在本机干活，不联网。**

## 为什么做这个

智能体能不能用上本机已有的能力，很大程度上取决于那个工具是否出现在它看得见的工具面里。没有对应工具时，处理压缩包通常会退回到最通用的做法：逐个文件、逐个目录地解压——慢，而且容易把原本的目录结构丢掉。

这个插件的做法是把 `bz.exe` 收进工具面：不需要调用方先记住本机装了什么，调用时也只需要说明做什么。`bz.exe` 那些容易出错的细节（`-o:` 的位置、`x` 与 `e` 的差别、缺覆盖开关会停在交互提示上、退出码 `1` 含义含糊）由插件承担。

另外一类检查通常不会被主动想到：这个包是否适合直接解。路径穿越、压缩炸弹、符号链接在写盘之前判断，任一不过就整包拒绝。

> **术语说明**
> - **参数**：智能体每次调用传的，写在工具 schema 里，如 `level`、`overwrite`、`include`、`timeoutSeconds`。
> - **设置**：你在插件页配的，跨调用生效，多为限权或环境，如 `allowArchiveOverwrite`、`restrictToWorkspace`、`allowPassword`、`bzPath`、`timeoutSeconds`（作为上限）。
> - **命令行开关**：`bz.exe` 自己的开关，如 `-aoa`、`-o:`、`-r-`，不要与前两者混称。

## 它提供什么

它向智能体注册 **9 个语义化工具**，每个工具的参数只声明它自己用得到的那几个（全部 `additionalProperties: false`），返回结构也各自独立——不再是一个工具 44 个输出字段的并集。

| # | 工具 | 一句话 |
|---|---|---|
| 1 | `list_archive` | 列出条目，并回答「是否加密」「是否分卷」 |
| 2 | `extract_archive` | 解压到目录；写盘前过三道防线 |
| 3 | `create_archive` | 打包 / 追加 / 分卷 / 加密，可选校验 |
| 4 | `compress_file` | 单个文件压成 gz / xz / zstd |
| 5 | `decompress_file` | 把 gz / xz / zstd 解回单个文件 |
| 6 | `check_archive` | 用 `bz t` 校验完整性，可选核对摘要 |
| 7 | `detect_format` | 按**魔数**识别格式（不看扩展名） |
| 8 | `diff_archive` | 按条目名 + 大小比较两个包 |
| 9 | `convert_archive` | 换格式 / 级别 / 密码，转完自检 |

### 1. `list_archive`

- **参数**：`archive`（必填）、`password?`、`filter?`（大小写不敏感的子串）、`limit?` / `offset?`（分页）、`encoding?`、`stats?`、`timeoutSeconds?`
- **返回**：`format`、`encrypted`（`true` / `false` / `'unknown'`）、`volumes: { split, parts }`、`entries`（含 `size` / `compressedSize` / `isDir`）、`total`、`totalUncompressedBytes`、`note`、`output`；未到最后一页时给 `nextOffset`；`stats:true` 时另有 `byExtension` / `topLevelDirs` / `largest`
- **注意点**：
  - **加密检测**：`bz l` 不标注加密（实测 bz 7.47 加密包的 Attr 仍是 `A___`）。ZIP / ZIPX 走插件自己的中央目录解析器，读 General Purpose Bit Flag 的 bit 0；7z / RAR / LZH / CAB 用「无密码跑一次 `bz t`，报密码错则判加密」的试探法（按路径 + 大小 + mtime 缓存，因为试探代价是一整趟读取）；tar 与单流格式没有加密概念，直接 `false`；探测失败**不抛错**，返回 `'unknown'`。判定来源（`zip-central-directory` / `bz-test-trial` / `format-cannot-encrypt` 等）写在 `note` 里，失败时还带上具体原因。
  - **分卷**：ZIP 按兄弟文件判断（`xxx.z01`、`xxx.z02`… 加最后一个 `.zip`），`parts` 含 `.zip` 本身。
  - **`stats:true`** 额外给出三项聚合：`byExtension`（扩展名 → `{ count, bytes }`）、`topLevelDirs`（顶层名字 → `{ entryCount, uncompressedBytes }`）、`largest`（前 10 个 `name` + `size`）。它们**从已经解析出来的 entries 计算，不多跑一次 `bz`**；口径是**整个包**——传了 `limit` / `offset` / `filter` 也不会让聚合只描述这一页，因为字段名承诺的是「这个包有什么」而不是「这次请求看到什么」。默认 `false`，四个统计字段（含 `totalUncompressedBytes`）**按需出现**，所以不在 `required` 里。
  - 加密的 7z/RAR **连列举都需要密码**；此时 `ok:false`，`note` 会直接说「给 password 再试」，因为修法只差一个参数。
  - 只读（`isConcurrencySafe`）。

### 2. `extract_archive`

- **参数**：`archive`、`destination`（均必填）、`overwrite`（必填：`overwrite` / `skip` / `rename`）、`password?`、`include?` / `exclude?`（包内掩码）、`encoding?`、`dryRun?`、`checksum?`、`symlinks?`（`reject` / `skip` / `allow`）、`flat?`、`timeoutSeconds?`
- **返回**：`extracted`、`entries`（含 `landed` 落地路径）、`conflicts`（**解压前**已存在的目标文件，前 20 条）、`skipped`、`rejected`、`symlinks`、`wouldCreate` / `wouldOverwrite` / `wouldSkip`（`dryRun`）、`note`、`output`
- **注意点**：
  - 写盘之前依次过三道检查，任一不过整包拒绝（`ok:false` + `rejected:true`）：zip-slip（`..` / 绝对路径 / 盘符）、压缩炸弹上限（设置 `maxExtractBytes`，把条目**声明**的解压后大小求和）、符号链接条目。
  - `symlinks` 把策略变成按次决定：`reject`（缺省，跟随设置 `rejectSymlinkEntries`）整包拒绝；`skip` 只丢掉链接条目、其余照解；`allow` 原样处理。只有 ZIP（中央目录）与 tar（typeflag）能被检查。
  - `checksum` 先核对压缩包本身，不匹配就直接拒绝，一个字节都不写。
  - **`flat:true`** 用 bz 的 `e` 命令解压，丢掉目录名、所有文件直接落到 `destination`：`entries[].landed` 同步变成裸文件名，「可上提一层」那句提示在 `flat` 下不再出现。与 `include` / `exclude` 同时给时，逐条目解压的路径也切到 `e`（`e` 同样接受文件名掩码）。**符号链接预检不变**——`flat` 只换解压命令，三道防线一道都不跳过。代价是扁平化后 `src/a.txt` 与 `lib/a.txt` 会撞名，谁活下来由 `overwrite` 策略决定。
  - `destination` **必填**（旧版可以省略、默认解到包旁同名目录；语义化工具不替调用方猜落地位置）。
  - `conflicts` 是**解压前**的快照——解压后目录里每个选中文件都存在，事后扫描会把整包都报成冲突。

### 3. `create_archive`

- **参数**：`archive`、`files`（均必填）、`format?`、`level?`、`include?` / `exclude?`（相对会话工作目录的 glob）、`volumeSize?`、`password?`、`mode?`（`create` / `append`）、`overwrite?`（只接受 `'overwrite'`）、`verify?`（`true` / `'roundtrip'`）、`recursive?`、`timeoutSeconds?`
- **返回**：`format`、`size`、`parts`（分卷时）、`digest: { algorithm, hex }`、`verified`、`roundtrip`、`mode`、`note`、`output`
- **注意点**：
  - 支持 zip、zipx、7z、tar、tgz、gz、xz、iso、lzh、自解压 exe；`rar` 等格式可读取但由其它工具间接支持。
  - `digest` 是产物 sha256，创建成功即返回，不必开 `verify`。
  - `verify:true` 跑一次完整 `bz t`；`verify:"roundtrip"` 另外把包解到临时目录、逐文件比对大小与 SHA-256——证明打进去的东西原样出来了，而不只是容器没坏。校验失败不删包。
  - **不覆盖同名包**：两道闸门——设置 `allowArchiveOverwrite` 关闭时一律拒绝；即便开启，也必须显式传 `overwrite:"overwrite"`。
  - `volumeSize` 分卷时 `size` 报的是**所有分片合计**（只报 `.zip` 会把 400 KB 的包说成几十 KB）。
  - **`recursive:false`** 只打包每个目录的**顶层文件**：argv 加 `-r-`，目录条目改写成 `dir/*`（bz 的 `-r-` 只约束通配展开，名字点明的目录仍会被整个走一遍，所以两件事都必须做）。浅层模式下「不含顶层文件的目录」会被跳过并记进 `note`（含只有空子目录的目录），全部为原则直接报错。与 `include` / `exclude` 同时给时**明确报错**而不是猜顺序：浅层按目录深度选文件、glob 按路径选文件，两者对「你点名的那个目录」理解不一致。`verify:"roundtrip"` 理解浅层模式——深层文件本来就不该进包，不算缺失。
  - `exclude` 由插件在展开源文件时过滤，不交给 bz 的 `-x:`（实测 `-x:` 对这里构造的文件列表不生效）。

### 4. `compress_file`

- **参数**：`file`、`format`（均必填：`gz` / `xz` / `zstd`）、`destination?`、`level?`、`overwrite?`、`timeoutSeconds?`
- **返回**：`output`、`format`、`inputBytes`、`outputBytes`、`ratio`、`note`
- **注意点**：
  - gz / zstd 走 `node:zlib` 流式压缩；**zstd 需要 Node ≥ 22.15**，用 `typeof zlib.zstdCompress === 'function'` 探测，缺失时报「当前运行时无 zstd」而不是崩溃。
  - xz 由 `bz.exe` 完成（`node:zlib` 没有 xz 编解码器），仍然流式、仍然零依赖。
  - `level` 0–9；zstd 没有 store 模式，所以 0 表示「库默认」。
  - 目标文件已存在时**默认拒绝**，要覆盖得传 `overwrite:true`。

### 5. `decompress_file`

- **参数**：`file`（必填）、`format?`（省略时由魔数决定，文件名兜底）、`destination?`、`overwrite?`、`timeoutSeconds?`
- **返回**：同 `compress_file`
- **注意点**：
  - `destination` 省略时由文件名剥掉 `.gz` / `.xz` / `.zst` / `.zstd` 得到；剥不出来就要求显式给 `destination`。
  - xz 的解压是「解到私有临时目录 → 取唯一的产物 → 拷到目标」：bz 只认「压缩包名去掉后缀」这一种命名，直接解到旁边会和已有文件抢名字。

### 6. `check_archive`

- **参数**：`archive`（必填）、`password?`、`checksum?`、`timeoutSeconds?`
- **返回**：`integrity`（`ok` / `failed`）、`exitCode`、`checksum: { algorithm, expected, actual, matched }`、`note`、`output`
- **注意点**：
  - `bz t` 是唯一真正读取条目数据的命令；`bz l` 只读中央目录，坏包也会报「看着还行」，两者不能共用实现。
  - 容器完好与「文件就是那个摘要描述的文件」是两件事，所以分成 `integrity` 与 `checksum` 两个字段并排报。
  - `checksum` 接受 `"<算法>:<hex>"`（md5 / sha1 / sha256 / sha512），也接受裸 hex（长度唯一确定算法：32/40/64/128）；长度对不上就报错，而不是默认当成 sha256 造成假不匹配。
  - 只读。

### 7. `detect_format`

- **参数**：`path`（必填）、`timeoutSeconds?`
- **返回**：`format`、`confidence`（`magic` / `engine` / `extension` / `unknown`）、`encryptedGuess`、`isArchive`、`size`、`note`
- **注意点**：
  - **按魔数识别**，不看扩展名：ZIP（`50 4B 03 04` / `05 06` / `07 08`）、7z（`37 7A BC AF 27 1C`）、RAR（`52 61 72 21 1A 07`）、GZIP（`1F 8B`）、XZ（`FD 37 7A 58 5A 00`）、BZIP2（`42 5A 68`）、ZSTD（`28 B5 2F FD`）、LZH（偏移 2 处 `-lh`）、TAR（偏移 257 处 `ustar`）、ISO（偏移 0x8001 处 `CD001`）、CAB（`MSCF`）、自解压 exe（`MZ`）。
  - 认不出时依次回退：跑 `bz l` 解析 `Archive format:` 行（`confidence: "engine"`）→ 扩展名（`confidence: "extension"`，此时 `isArchive: false`，因为字节没背书）→ 都认不出就是 `format: "unknown"` / `confidence: "unknown"`，这是**答案**而不是错误。
  - `encryptedGuess` 复用 `list_archive` 的探测逻辑，同样会给 `'unknown'`。
  - 只读。

### 8. `diff_archive`

- **参数**：`archive`、`archive2`（均必填）、`filter?`（按条目名收窄结果：纯文本按子串匹配，含 `*` / `?` 时按 glob）、`password?`、`timeoutSeconds?`
- **返回**：`counts: { added, removed, changed }`、`added` / `removed` / `changed`（各前 20 条）、`note`
- **注意点**：
  - **只按「条目名 + 大小」比较**：bz 清单只有名字和大小，大小相同的内容改动检测不到，`note` 会把这句话原样写出来，而不是让调用方以为做过内容比对。
  - 只读。

### 9. `convert_archive`

- **参数**：`archive`（必填）、`destination?`、`format?`（目标格式）、`level?`、`password?`（读源包）、`newPassword?`（写新包）、`deleteSource?`、`overwrite?`（只接受 `'overwrite'`）、`timeoutSeconds?`
- **返回**：`convertedTo`、`format`、`level`、`sourceDeleted`、`size`、`note`
- **注意点**：
  - 实现是「解到私有临时目录 → 重新打包」，**需要双倍磁盘**。
  - 目标包必须先通过 `bz t` 才算成功；`deleteSource:true` 只在产物落盘并校验通过后才删源包，删不掉会如实报 `sourceDeleted:false`。
  - 覆盖已有目标走 `create_archive` 同一道门控：`allowArchiveOverwrite` + 显式 `overwrite:"overwrite"`。

### 共同约定

- 所有路径相对**会话工作目录**解析；`restrictToWorkspace` 开启后越界一律拒绝。
- 每个工具都接受 `timeoutSeconds`（1–86400）覆盖设置里的超时上限——这是唯一一个所有工具共有的参数。
- 参数作用域是硬边界：宿主不会拿 `parameters` 校验实参，所以 `execute` 会自己拒绝不认识的参数，并在错误里列出该工具真正接受的名单；缺必填参数（如 `extract_archive` 的 `destination`）同样在调用时就被拒，不会退化成 `<cwd>/undefined`。

## 从 0.2.x 迁移（破坏性变更）

0.3.0 把「1 个工具 + 8 个 action」换成 9 个语义化工具，**旧调用全部失效**，没有兼容入口。

> 0.3.0 首次拆分时 `flat` / `recursive` / `preview` 被当成「拆分后的冗余」删掉了，随后又以参数形式回归：`flat` → `extract_archive`、`recursive` → `create_archive`、`preview` 的统计 → `list_archive` 的 `stats`。下表已经是回归后的状态。

| 旧调用 | 新调用 | 说明 |
|---|---|---|
| `bandizip {action:"list", archive}` | `list_archive {archive}` | 参数同名；新增 `encrypted` / `volumes` |
| `bandizip {action:"list", ..., filter/limit/offset/encoding}` | `list_archive {archive, filter, limit, offset, encoding}` | 语义不变 |
| `bandizip {action:"extract", archive, destination?}` | `extract_archive {archive, destination, overwrite}` | **`destination` 与 `overwrite` 变为必填**；`flat` 见下一行（参数化回归） |
| `bandizip {action:"extract", ..., include/exclude/overwrite/dryRun}` | `extract_archive {archive, destination, overwrite, include, exclude, dryRun}` | 三道防线、`dryRun` 语义不变 |
| `bandizip {action:"extract", ..., flat:true}` | `extract_archive {..., flat:true}` | **参数化回归**：语义不变，`e` 命令路径保留；符号链接预检照旧 |
| `bandizip {action:"create", archive, files}` | `create_archive {archive, files}` | 参数同名 |
| `bandizip {action:"create", ..., format/level/include/volumeSize/password/mode/verify}` | `create_archive {archive, files, ...}` | 语义不变；新增 `exclude` |
| `bandizip {action:"create", ..., recursive:false}` | `create_archive {..., recursive:false}` | **参数化回归**：默认 `true`，浅层模式保留；与 `include`/`exclude` 组合现在明确报错 |
| `bandizip {action:"create", ..., encoding}` | `create_archive {archive, files, ...}` | `encoding` 不再是 `create_archive` 的参数（它不解析条目名） |
| `bandizip {action:"test", archive, password}` | `check_archive {archive, password, checksum?}` | 新增 `checksum` 摘要核对 |
| `bandizip {action:"preview", archive}` | `list_archive {archive, stats:true}` | **参数化回归**：`byExtension` / `topLevelDirs` / `largest` / `totalUncompressedBytes` 原样返回 |
| `bandizip {action:"diff", archive, archive2}` | `diff_archive {archive, archive2, filter?}` | 语义不变，新增 `filter` |
| `bandizip {action:"browse", archive, path, depth}` | `list_archive {archive, filter}` | `browse` 取消：按层浏览用 `list_archive` + 路径前缀筛选 |
| `bandizip {action:"convert", archive, format, level, password, newPassword, deleteSource}` | `convert_archive {archive, destination?, format, level, password, newPassword, deleteSource, overwrite}` | 新增 `destination`（目标不再只能由源包名推导） |
| —（原先只能借 `create -fmt:gz/xz` 压缩单文件） | `compress_file {file, format}` / `decompress_file {file}` | 独立语义；**新增 zstd** |
| —（原先按扩展名推断格式，推不出就报错） | `detect_format {path}` | **改为按魔数**识别，扩展名只作提示 |

同时取消的参数：`action`、`archive2`（仅 `diff_archive` 保留）、`depth`、`path`（browse 专用，`detect_format` 里的 `path` 是另一个含义），以及 `preview` 与 `browse` 两个 action 本身（分别由 `list_archive` 的 `stats` 与 `filter` 承接）。`flat` 与 `recursive` 已作为参数回归。

## 安装（本地 bundle）

本插件以 `link:` 方式装进你的 profile（vendored 依赖必须随目录链接，见下方「已知限制」）。插件包自带的 `cordis.patch.yml` 内容为：

```yaml
- insert:
    - id: bandizip
      name: '@local/bandizip'
```

在 profile 的 `cordis.patch.yml` 里插入同样一条，即可把 `@local/bandizip` 这一行挂到 Loader：

```yaml
- insert:
    - id: bandizip
      name: '@local/bandizip'
```

`id` 是 Loader 行 id，`name` 必须与 `package.json` 的 `name` 一致。装好后可在插件详情页打开设置页，把 `bz.exe` 指到你的安装位置（默认会自动探测标准安装目录及 `BANDIZIP_BZ` 环境变量）。

## 配置项

与 `index.js` 中的 `Config`（Schemastery schema）完全一致，共 9 项；全部为 `.volatile()`，保存后立即生效，无需重启插件。注意这些是**插件全局设置**，上面各工具的参数（level / overwrite / mode / encoding / destination 等）的**缺省值都是按次调用的参数**，不在设置里固化：

| 字段 | 类型 | 缺省值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后不注册 bandizip 工具；其余设置保留。 |
| `bzPath` | string | `""` | `bz.exe` 完整路径；留空则自动探测标准 Bandizip 安装位置。 |
| `timeoutSeconds` | natural | `900` | 每次 `bz.exe` 调用的最长等待秒数（1–86400）；可用按次参数 `timeoutSeconds` 覆盖。超过后进程被杀，调用以超时失败。 |
| `maxOutputChars` | natural | `12000` | 回传给模型的输出上限（字符，500–200000）。超出部分截断，并在末尾标注总长度。 |
| `allowArchiveOverwrite` | boolean | `false` | 允许 `create_archive` / `convert_archive` 覆盖已存在的同名压缩包。关闭时即使显式传 `overwrite:"overwrite"` 也会被拒绝，用来防止误删旧包。 |
| `allowPassword` | boolean | `true` | 是否允许把密码交给 `bz.exe`。关闭后任何带 `password` / `newPassword` 的调用都会失败；密码以 argv 传递，本机其它进程可见。 |
| `restrictToWorkspace` | boolean | `false` | 拒绝工作区之外的 archive / files / destination。开启后会挡掉工作区外的合法跨盘操作，只在需要强边界时启用。 |
| `maxExtractBytes` | natural | `0` | 解压前的压缩炸弹上限（字节）：把压缩包内各条目**声明**的解压后大小相加，超过就整包拒绝，`0` 表示不检查。尺寸来自压缩包自身的声明，异常包可能谎报，所以它是三道解压前防线之一，不是唯一防线。 |
| `rejectSymlinkEntries` | boolean | `true` | 解压前拒绝含符号链接条目的压缩包（符号链接可把后续写入引出目标目录）。这是 `extract_archive` 的 `symlinks` 参数缺省值：**zip / zipx 读中央目录属性位、tar 读 typeflag**；7z 等格式不做此检查，该项对它们不起作用。 |

## 已知限制 / 注意事项

- **必须本机安装 Bandizip** 且带控制台程序 `bz.exe`（标准安装目录或 `BANDIZIP_BZ` 环境变量）；找不到时工具会报错并提示如何配置。裸文件名会交给 `PATH` 解析。
- **vendored 依赖**：`node_modules/@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 随包附带，并在 `package.json` 的 `files` 中声明。因此只能用 `link:` 安装；`npm pack` / 仓库安装会丢掉 `node_modules`，导致 `import Schema` 失败。升级 DSH 后若 schemastery 版本变化，需重新从新安装的 `app.asar` 里提取这两个包。
- **密码不能含双引号 `"`**：`bz.exe` 会把内嵌双引号吃掉导致参数解析错误（已针对 bz 7.47 验证）。含 `"` 的密码会被直接拒绝。
- **输出编码**：默认按 UTF-8 解码、乱码时回退 GBK；`list_archive` / `extract_archive` / `create_archive` 可用按次参数 `encoding`（`auto` / `utf-8` / `gbk`）显式指定。
- **zstd 依赖运行时**：Node ≥ 22.15 才有 `zlib.zstdCompress` / `zstdDecompress`；缺失时 `compress_file` / `decompress_file` 明确报错，`detect_format` 仍然认得出 zstd 格式。
- **ZIP 中央目录解析有上限**：读中央目录是插件唯一把整块结构读进内存的地方，超过 4 MB 就跳过加密位 / 符号链接探测并在 `note` 里说明（越过上限不等于「确认干净」）。
- **`binary payload 的 tgz 判定靠名字**：gzip 容器不说明载荷，魔数命中 `1F 8B` 时若文件名以 `.tar.gz` / `.tgz` 结尾才报 `tgz`。
- **tar 符号链接只认 typeflag `'2'`**：GNU 长名（`L`/`K`）与 pax 头会被按尺寸跳过，经由它们传递的链接名会以短名形式报出——拒绝信息需要的正是这个名字。
- 受 Windows 命令行与进程限制，按次 `timeoutSeconds` 上限为 86400（超过会被 `setTimeout` 悄悄改成 1 ms，代码里也做了钳制）。

## 与同类的差异

压缩包工具可以分成两拨：给智能体用的，和给人用的。

DSH 生态里已经有一个面向智能体的压缩包插件——`yuehancn/dsh-tool-archive`：注册 `archive_pack` / `archive_unpack` / `archive_status` / `archive_verify` 四个工具，tar 格式自己读自己写、零外部依赖，确定性打包，解包时逐个成员拒绝写到目标目录之外，并用 SHA-256 核对解出来的东西。MCP 侧另有 `zipnative-mcp`（十几个 typed tool，默认开启 traversal / symlink / bomb 防护）与 `zv-louis/mcp7zop`（包一层本地 7-Zip 命令行）。

这些项目的共同点是**自带引擎**：要么自己实现格式，要么随包分发一套压缩能力。本插件走的是另一条路——**不新增引擎，把本机已经装好的 Bandizip 接进智能体的工具面**。

| | `dsh-tool-archive` | 本插件 |
|---|---|---|
| 引擎 | 自实现 tar | 复用本机 `bz.exe`（gz / zstd 走 `node:zlib`） |
| 格式 | tar | zip / zipx / 7z / iso / exe / lzh / tar 系，另有 gz / xz / zstd 单流 |
| 确定性、校验和 | 强项（确定性 tar + SHA-256） | 无（用 `bz t` 校验完整性 + 产物 sha256 摘要） |
| 运行前提 | 零依赖、跨平台 | Windows + 已装 Bandizip |
| 工具形态 | 4 个工具 | 9 个语义化工具 |

其余几条是相对 MCP 那批的差异：

1. **每个动作一个语义化工具，而不是一个工具塞八个 action。** 抽样到的压缩包项目大多只做 create / list / extract「三件套」，并且倾向每动作注册一个独立 tool；这里同样按动作拆开——参数各有归属、输出各有一套 schema，调用方不会拿到与自己无关的 30 多个字段。
2. **能力按「对象」而非「动作」划分。** `compress_file` / `decompress_file` 处理的是单文件流，`*_archive` 处理的是容器，`detect_format` 处理的是任意文件；三者混在一个 action 枚举里时，`format` 参数的含义要分三种情况解释。
3. **设置只保留限权、环境事实与上限。** 9 项设置里没有一项是「默认压缩级别」这类行为偏好——level、overwrite、mode、encoding、destination 全部由每次调用给出。剩下的设置只回答三件事：能不能用、用到什么、硬上限。
4. **解压前有三道防线。** zip-slip、压缩炸弹上限、符号链接条目，任一不过整包拒绝，且 `symlinks` 让你按次选择「整包拒绝 / 只丢链接 / 原样放行」。**这几项不是本插件独有**（`zipnative-mcp` 与 `dsh-tool-archive` 都有各自的守卫），差别在于这里的守卫组合在一台机器的多格式引擎上。
5. **`diff_archive` 与 `convert_archive` 在抽样范围内没有见到同类实现。** 两者都保留：`diff_archive` 明确写出「只按名字 + 大小比较」的口径，`convert_archive` 转完自动用 `bz t` 校验，`deleteSource` 只在成功后才删源包。

> 调研口径：以上「没有见到」均指本轮抽样范围（项目页存在性已抽查，CVE / GHSA 编号未逐个核对）。横向对比会过时，请当作写作时点的观察。

## 安全说明（哪些操作有破坏性）

- `create_archive` 在 `allowArchiveOverwrite:true` 且调用显式传 `overwrite:"overwrite"` 时，会**覆盖同名已有压缩包**；默认拒绝覆盖，请留意旧包。`convert_archive` 的目标包也走同一道覆盖门控。
- `extract_archive` 的 `overwrite` 是**必填参数**（`overwrite` / `skip` / `rename`），不传就报错——不存在「默认覆盖」这种隐式行为。
- `convert_archive` 的 `deleteSource:true` 会**删除源压缩包**（仅在成功并校验后）。
- `compress_file` / `decompress_file` 默认**不覆盖**已存在的输出文件，要覆盖得传 `overwrite:true`。
- `password` / `newPassword` 通过命令行参数传给 `bz.exe`，**本机其它进程可见**；不需要时可关闭 `allowPassword`。
- `restrictToWorkspace` 默认关闭；开启前请理解它会拒绝工作区外的合法路径。
- `extract_archive` 在写盘前会过三道检查（zip-slip、压缩炸弹上限、符号链接条目），任一不过整包拒绝；`maxExtractBytes` 与 `rejectSymlinkEntries` 默认分别为 `0`（不检查）与 `true`（检查），后者覆盖 zip / zipx / tar。
- 会写文件的工具：`extract_archive`、`create_archive`、`compress_file`、`decompress_file`、`convert_archive`；只读的是 `list_archive`、`check_archive`、`detect_format`、`diff_archive`（`isConcurrencySafe` 为 true）。

## License

MIT © 2026 a-molecule-of-ATP。详见 [LICENSE](LICENSE)。

---

**English summary:** A DeepSeek Harness plugin that registers nine semantic model tools — `list_archive`, `extract_archive`, `create_archive`, `compress_file`, `decompress_file`, `check_archive`, `detect_format`, `diff_archive`, `convert_archive` — over a locally installed Bandizip console executable (`bz.exe`). Each tool declares only the arguments it reads (`additionalProperties: false`) and has its own output schema. `detect_format` identifies files by magic bytes, falling back to a `bz l` probe and then the extension; `list_archive` reports encryption (ZIP central-directory flag, or a password-less `bz t` trial for 7z/RAR) and split volumes; `compress_file`/`decompress_file` cover gz, xz and zstd through `node:zlib` (zstd needs Node ≥ 22.15, xz is delegated to bz). Extraction keeps three pre-write guards — zip-slip, a declared-size bomb ceiling, and a zip/tar symlink policy — and any failure rejects the whole archive. It is a local-only, link-installed bundle that vendors its Schemastery dependency. Licensed MIT. 0.3.0 is a clean breaking change from the 0.2.x single-tool form; the migration table is above.
