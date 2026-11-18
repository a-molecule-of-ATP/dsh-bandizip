# Bandizip 插件（dsh-bandizip）

一个让 DeepSeek Harness 智能体调用本机 Bandizip 控制台程序（`bz.exe`）来压缩、解压、查看、校验、预览、比较、浏览与转换压缩包的 DSH 插件。**只在本机干活，不联网。**

> **术语说明**
> - **参数**：智能体每次调用传的，写在工具 schema 里，如 `level`、`overwrite`、`include`、`timeoutSeconds`。
> - **设置**：你在插件页配的，跨调用生效，多为限权或环境，如 `allowArchiveOverwrite`、`restrictToWorkspace`、`allowPassword`、`bzPath`、`timeoutSeconds`（作为上限）。
> - **命令行开关**：`bz.exe` 自己的开关，如 `-aoa`、`-o:`、`-r-`，不要与前两者混称。

## 它提供什么

它向智能体注册 **1 个工具 `bandizip`**，通过 `action` 参数完成 **8 种操作**（`create` / `extract` / `list` / `test` 是基本操作，`preview` / `diff` / `browse` / `convert` 是派生检查与重打包）：

- `create`：把文件/文件夹压缩成新压缩包（支持 zip、zipx、7z、tar、tgz、gz、xz、iso、lzh、自解压 exe；`rar` 等格式可读取但由解压/列举间接支持）。可用 `format` 指定格式、`level`（0–9，默认 5）指定级别、`include` 通配筛选要加入的路径、`mode:append` 追加到已有包、`verify` 生成后做完整性校验。
- `extract`：把压缩包解压到指定目录（默认解到压缩包同名文件夹）。支持 `include` / `exclude` 掩码筛选条目、`flat` 扁平化、`overwrite` 覆盖策略、`encoding` 解码，并做 zip-slip 路径检查；执行逻辑还支持 `dryRun` 预演（只报告 wouldCreate / wouldOverwrite / wouldSkip 与冲突，不写文件，见「已知限制」）。
- `list`：列出压缩包内的条目，可按文字过滤（`filter`），并用 `limit` / `offset` 分页、`encoding` 指定解码。
- `test`：校验压缩包完整性与密码。
- `preview`：不解压地查看压缩包内容，给出大小 / 扩展名统计与顶层目录等摘要。
- `diff`：按条目大小比较两个压缩包（`archive` 为第一个、`archive2` 为第二个），报告 `added` / `removed` / `changed`。
- `browse`：树状浏览压缩包内某一层目录，用 `path` 指定包内前缀、`depth`（默认 1）控制向下合并几层。
- `convert`：把压缩包重打包成另一种格式 / 级别 / 密码；`format` 是目标格式、`password` 是读取源包用的密码、`newPassword` 是新包密码、`deleteSource:true` 在转换成功并校验后删除源包。

所有行为都由**每次调用的参数**决定，不在插件里固化（参数的缺省值：压缩级别 `level` 5、递归 `recursive` true、覆盖 `overwrite` overwrite、扁平化 `flat` false、`mode` create、`encoding` auto、目录浏览 `depth` 1、`offset` 0、解压目标为包旁同名目录）；每次调用还可用参数 `timeoutSeconds`（1–86400）覆盖设置的超时上限。工具是非交互式的：受密码保护的压缩包需显式传 `password`（关闭 `allowPassword` 后一律拒绝）。

它带**设置页**，分组如下：总开关（启用/停用工具）、执行器（`bz.exe` 路径、超时、输出上限）、打包（是否允许覆盖同名压缩包）、安全（是否允许密码、是否限制在工作区内）。

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

与 `index.js` 中的 `Config`（Schemastery schema）完全一致，共 7 项；全部为 `.volatile()`，保存后立即生效，无需重启插件。注意这些是**插件全局设置**，上面「它提供什么」里列出的 level / recursive / overwrite / flat 等行为的**缺省值都是按次调用的参数**，不在设置里固化：

| 字段 | 类型 | 缺省值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后不注册 bandizip 工具；其余设置保留。 |
| `bzPath` | string | `""` | `bz.exe` 完整路径；留空则自动探测标准 Bandizip 安装位置。 |
| `timeoutSeconds` | natural | `900` | 每次 `bz.exe` 调用的最长等待秒数（1–86400）；可用按次参数 `timeoutSeconds` 覆盖。超过后进程被杀，调用以超时失败。 |
| `maxOutputChars` | natural | `12000` | 回传给模型的输出上限（字符，500–200000）。超出部分截断，并在末尾标注总长度。 |
| `allowArchiveOverwrite` | boolean | `false` | 允许 `create` 覆盖已存在的同名压缩包。关闭时即使显式传 `overwrite:"overwrite"` 也会被拒绝，用来防止误删旧包。 |
| `allowPassword` | boolean | `true` | 是否允许把密码交给 `bz.exe`。关闭后任何带 `password` 的调用都会失败；密码以 argv 传递，本机其它进程可见。 |
| `restrictToWorkspace` | boolean | `false` | 拒绝工作区之外的 archive / files / destination。开启后会挡掉工作区外的合法跨盘操作，只在需要强边界时启用。 |

## 已知限制 / 注意事项

- **必须本机安装 Bandizip** 且带控制台程序 `bz.exe`（标准安装目录或 `BANDIZIP_BZ` 环境变量）；找不到时工具会报错并提示如何配置。裸文件名会交给 `PATH` 解析。
- **vendored 依赖**：`node_modules/@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 随包附带，并在 `package.json` 的 `files` 中声明。因此只能用 `link:` 安装；`npm pack` / 仓库安装会丢掉 `node_modules`，导致 `import Schema` 失败。升级 DSH 后若 schemastery 版本变化，需重新从新安装的 `app.asar` 里提取这两个包。
- **密码不能含双引号 `"`**：`bz.exe` 会把内嵌双引号吃掉导致参数解析错误（已针对 bz 7.47 验证）。含 `"` 的密码会被直接拒绝。
- **输出编码**：默认按 UTF-8 解码、乱码时回退 GBK；`list` / `extract` 可用按次参数 `encoding`（`auto` / `utf-8` / `gbk`）显式指定。
- **`dryRun` 只作用于 `extract`**：它报告 `wouldCreate` / `wouldOverwrite` / `wouldSkip` 与前 20 条冲突，不写任何文件；顺带做 zip-slip 检查，条目里出现 `..`、绝对路径或盘符时整包拒绝。`create` 传它没有效果。
- `convert` 的 `deleteSource` 只有在转换产物落盘并校验通过后才会删除源包，失败时忽略；`newPassword` 省略时新包不加密。
- 受 Windows 命令行与进程限制，按次 `timeoutSeconds` 上限为 86400（超过会被 `setTimeout` 悄悄改成 1 ms，代码里也做了钳制）。

## 安全说明（哪些操作有破坏性）

- `create` 在 `allowArchiveOverwrite:true` 且调用显式传 `overwrite:"overwrite"` 时，会**覆盖同名已有压缩包**；默认拒绝覆盖，请留意旧包。`convert` 的目标包也走同一道覆盖门控。
- `extract` 的 `overwrite` 默认是 `overwrite`，即**覆盖目标目录里的同名文件**；不想覆盖请传 `skip` 或 `rename`。
- `convert` 的 `deleteSource:true` 会**删除源压缩包**（仅在成功并校验后）。
- `password` 通过命令行参数传给 `bz.exe`，**本机其它进程可见**；不需要时可关闭 `allowPassword`。
- `restrictToWorkspace` 默认关闭；开启前请理解它会拒绝工作区外的合法路径。
- `create`（append 模式除外）、`extract`、`convert` 会写文件；`list` / `test` / `preview` / `diff` / `browse` 是只读的（`isConcurrencySafe` 为 true）。

## License

MIT © 2026 dafeiyu。详见 [LICENSE](LICENSE)。

---

**English summary:** A DeepSeek Harness plugin that exposes one model tool, `bandizip`, to create, extract, list, test, preview, diff, browse, and convert archives through a locally installed Bandizip console executable (`bz.exe`). Eight actions are selected per call; all argument defaults (level 5, recursive, overwrite, flat, mode, encoding, destination) are per-call arguments rather than fixed in the plugin. Seven volatile settings (including an overwrite gate and an allow-password setting) are editable in the bundled settings page. It is a local-only, link-installed bundle that vendors its Schemastery dependency. Licensed MIT.
