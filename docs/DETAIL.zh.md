# Bandizip 压缩包：把打包和解包交给 bz.exe

![一叠文件被装进带拉链的压缩包](preview.svg)

> **术语说明**
> - **参数**：智能体每次调用传的，写在工具 schema 里，如 `level`、`overwrite`、`include`、`timeoutSeconds`。
> - **设置**：你在插件页配的，跨调用生效，多为限权或环境，如 `allowArchiveOverwrite`、`restrictToWorkspace`、`allowPassword`、`bzPath`、`maxExtractBytes`、`rejectSymlinkEntries`、`timeoutSeconds`（作为上限）。
> - **命令行开关**：`bz.exe` 自己的开关，如 `-aoa`、`-o:`、`-r-`，不要与前两者混称。

## 它解决什么问题

智能体要处理压缩包时，最省事的做法是让它自己拼 `bz.exe` 的命令行——但 `bz` 的命令行开关有坑：`-o:` 必须放在压缩包之前、`x` 和 `e` 决定要不要保留目录结构、缺了覆盖命令行开关（`-ao*`）会停在交互提示上、退出码 1 既可能是警告也可能是失败。这个插件把这些细节收进一个工具里，让智能体只需要说清「做什么」。

## 八个 action

| action | 干什么 | 关键参数 |
|---|---|---|
| `create` | 打包成新压缩包 | `files`、`format`、`level`、`include`（通配筛选）、`mode`（`create` / `append`）、`password` |
| `extract` | 解压到目录；写盘前过三道防线 | `destination`、`include` / `exclude`（包内掩码）、`overwrite`、`flat`、`dryRun` |
| `list` | 列出条目，可过滤、可翻页 | `filter`、`limit`、`offset`、`encoding` |
| `test` | 用 `bz t` 逐条校验数据段与密码 | `password` |
| `preview` | 只看不解，给聚合视图 | 复用 `list` 的参数 |
| `diff` | 比较两个包 | `archive2` |
| `browse` | 按层浏览包内目录 | `path`、`depth` |
| `convert` | 换格式 / 换级别 / 改密码 | `format`、`level`、`password`、`newPassword`、`deleteSource` |

## 掩码怎么匹配

`include` / `exclude` 的掩码是**相对包根的路径**，`*` 只代表一层。三种情况都会返回成功——包括一条都没匹配到的那种。**插件只看 bz 的退出码，不会替你检测「空匹配」，请自己核对返回的条目数**：

![三种掩码各自命中的条目](masks.zh.svg)

## 典型用法

只看包里有什么，不落地：

```json
{"action": "preview", "archive": "release.zip"}
```

只解出需要的子集（掩码相对包根，用反斜杠）：

```json
{"action": "extract", "archive": "assets.zip", "destination": "out", "include": ["assets\\scene\\*.js"]}
```

先把冲突摸清楚再动手：

```json
{"action": "extract", "archive": "assets.zip", "destination": "out", "dryRun": true}
```

打包时按通配筛选，并在完成后自检：

```json
{"action": "create", "archive": "src.zip", "files": ["."], "include": ["**/*.ts"], "verify": true}
```

比较两版包的差异：

```json
{"action": "diff", "archive": "v1.zip", "archive2": "v2.zip"}
```

## 行为都在调用时决定

### 参数与设置的区别

下表的「缺省」是**工具参数**在调用未指定时采用的 schema 缺省值，由智能体每次调用按情况传入或省略；而**设置**是你在插件页配置的、跨调用生效的限权与环境项（如 `allowArchiveOverwrite`、`restrictToWorkspace`、`allowPassword`、`bzPath`）。两者不同：改参数只影响这一次调用，改设置影响之后的每一次调用。需要别的取值就当场传参：

| 参数 | 缺省 |
|---|---|
| `level` | `5`（0 只打包不压缩，9 体积最小） |
| `recursive` | `true` |
| `overwrite` | `overwrite`（解压时替换同名文件） |
| `flat` | `false`（保留目录结构） |
| `destination` | 压缩包旁边的同名文件夹 |
| `volumeSize` | 无（不分卷） |
| `mode` | `create` |
| `encoding` | `auto`（UTF-8 失败回退 GBK） |
| `timeoutSeconds` | 这是**参数**：缺省取设置里的 `timeoutSeconds`（缺省值 900 秒）；本次调用传入时优先 |

## 安全与边界

- **密码走命令行**：以 `bz.exe` 参数形式传递，本机其它进程可以在进程列表里看到。不需要密码能力时，在插件页关闭 `allowPassword`。
- **create 不覆盖同名包**：两道闸门——`allowArchiveOverwrite` 关闭时一律拒绝；即使开启，也必须显式传 `overwrite: "overwrite"`。
- **`restrictToWorkspace`**：开启后 `archive` / `files` / `destination` 都被限制在会话工作区内。
- **解压前的三道防线**：`extract` 在写盘之前依次检查，任一不过就整包拒绝（返回 `ok:false` 与 `rejected:true`）：
  - **zip-slip**：条目里出现 `..`、绝对路径或盘符时拒绝，并报出问题条目名。
  - **压缩炸弹上限**（设置 `maxExtractBytes`）：把各条目**声明**的解压后大小相加，超过上限就拒绝；`0` 表示不检查。这个尺寸来自压缩包自己的声明，异常包可能谎报，所以它是早期止损而不是证明。
  - **符号链接条目**（设置 `rejectSymlinkEntries`，默认开）：符号链接可以把后续写入引出目标目录。`bz l` 的属性列只带目录标志和 DOS 归档位，符号链接条目打印出来和普通文件一样，所以插件改为直接读 ZIP 中央目录里的 Unix 模式位来识别。**只有 zip / zipx 能检查**；7z / tar 等格式、以及 ZIP64 中央目录，都不在本项覆盖范围内，此时这项不起作用而不是「已确认干净」。
- **`dryRun` 也走上面三道检查**：`dryRun` 分支排在这些检查之后，所以它同样会因路径穿越、超限或符号链接而拒绝整包。
- **`convert` 要双倍磁盘**：实现方式是解压到临时目录再重新打包，大包请先确认空间。

## 已知限制

- **`diff` 只能按「名字 + 大小」比较**：同大小但内容不同的改动检测不到，输出里会明确写这一点。
- **加密封包列不出条目**：7z 加密包在 `list` 阶段就会要求密码，此时 `preview` / `diff` 拿不到数据；给了 `password` 才能列。
- **没有修复和挂载**：`bz.exe` 是纯命令行压缩器，没有 repair、也没有挂载能力；损坏的包只能尽量解出可解的部分。
- **符号链接检查只覆盖 zip / zipx**：7z / tar 等格式的条目类型不在 `bz l` 的输出里，插件不做猜测；ZIP64 中央目录也跳过扫描。这些情况下 `rejectSymlinkEntries` 不生效，不要把它理解为「已确认无符号链接」。
- **相对路径以会话工作目录为基准**，不是插件目录。

## 与同类的差异

以下是我们对压缩包类 MCP / 插件项目做过一轮抽样调研后的观察。**凡属「抽样范围内没找到」的，就按抽样范围写**，不代表整个生态没有。

- **一个工具 + 8 个 action，而不是每动作一个工具。** 抽样到的压缩包类项目大多只做 create / list / extract 这「三件套」，并且倾向每个动作注册一个独立 tool（有的项目注册到十几个）。这里收成一个 `bandizip` 工具，用 `action` 分派：工具清单只多一行，参数 schema 也只维护一份。
- **设置只保留限权、环境事实与上限，行为细节一律逐次传参。** 9 项设置里没有「默认压缩级别」「默认递归」这类行为偏好——level、recursive、overwrite、flat、mode、encoding、destination 全部由每次调用显式给出。设置只回答三件事：能不能用（`enabled`、`allowPassword`、`allowArchiveOverwrite`）、用什么执行（`bzPath`）、硬上限是什么（`timeoutSeconds`、`maxOutputChars`、`maxExtractBytes`、`rejectSymlinkEntries`、`restrictToWorkspace`）。在我们抽样范围内，没有找到第二家把这条写成显式设计原则的项目。
- **`test` 用真正的 `bz t`，解压前另有三道防线。** `bz l` 只读中央目录，数据段损坏它照样报告正常，所以 `test` 单独走 `bz t` 逐条校验。`extract` 在写盘前依次过 zip-slip、压缩炸弹上限、符号链接条目三道检查，任一不过整包拒绝。抽样中明确提供「不解压即校验」的只有 `zipnative-mcp`；把这三道解压前检查做齐的，在抽样范围内没有找到第二家。
- **提供 `diff` / `convert` 这类能力。** 抽样范围内没有一家明确提供按条目比较两个包（`diff`）或重打包成另一种格式 / 级别 / 密码（`convert`）。在这里两者都是普通 action，且各自写明口径：`diff` 会明确写出「只按名字 + 大小比较」，`convert` 转完自动用 `bz t` 校验、`deleteSource` 只在成功后才删源包。

形态上最接近本项目的是 `zv-louis/mcp7zop`，同样是把本地 7-Zip 命令行包一层。另一个对照点：官方 MCP 的 `filesystem` server 已经有 realpath 解析和 allowed-directories，但公开记录里仍出现过路径穿越与 TOCTOU 问题——这说明「沙箱化路径访问」是个会反复出问题的面，不是一次配好就永久有效。

> 调研口径：以上「没找到」均指本轮抽样范围（以代理转述为主，项目页存在性已抽查，CVE / GHSA 编号未逐个核对）。横向比较容易过时，请当作写作时点的观察。
