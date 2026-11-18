# Bandizip 压缩包：把打包和解包交给 bz.exe

![一叠文件被装进带拉链的压缩包](preview.svg)

## 它解决什么问题

智能体要处理压缩包时，最省事的做法是让它自己拼 `bz.exe` 的命令行——但 `bz` 的参数有坑：`-o:` 必须放在压缩包之前、`x` 和 `e` 决定要不要保留目录结构、缺了覆盖开关会停在交互提示上、退出码 1 既可能是警告也可能是失败。这个插件把这些细节收进一个工具里，让智能体只需要说清「做什么」。

## 八个 action

| action | 干什么 | 关键参数 |
|---|---|---|
| `create` | 打包成新压缩包 | `files`、`format`、`level`、`include`（通配筛选）、`mode`（`create` / `append`）、`password` |
| `extract` | 解压到目录 | `destination`、`include` / `exclude`（包内掩码）、`overwrite`、`flat`、`dryRun` |
| `list` | 列出条目，可过滤、可翻页 | `filter`、`limit`、`offset`、`encoding` |
| `test` | 校验完整性与密码 | `password` |
| `preview` | 只看不解，给聚合视图 | 复用 `list` 的参数 |
| `diff` | 比较两个包 | `archive2` |
| `browse` | 按层浏览包内目录 | `path`、`depth` |
| `convert` | 换格式 / 换级别 / 改密码 | `format`、`level`、`password`、`newPassword`、`deleteSource` |

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

这些默认值**不是插件里的设置**，而是每次调用的参数缺省值——需要别的就当场传：

| 参数 | 缺省 |
|---|---|
| `level` | `5`（0 只打包不压缩，9 体积最小） |
| `recursive` | `true` |
| `overwrite` | `overwrite`（解压时替换同名文件） |
| `flat` | `false`（保留目录结构） |
| `destination` | 压缩包旁边的同名文件夹 |
| `mode` | `create` |
| `encoding` | `auto`（UTF-8 失败回退 GBK） |
| `timeoutSeconds` | 插件配置值，默认 900 秒 |

## 安全与边界

- **密码走命令行**：以 `bz.exe` 参数形式传递，本机其它进程可以在进程列表里看到。不需要密码能力时，在插件页关闭 `allowPassword`。
- **create 不覆盖同名包**：两道闸门——`allowArchiveOverwrite` 关闭时一律拒绝；即使开启，也必须显式传 `overwrite: "overwrite"`。
- **`restrictToWorkspace`**：开启后 `archive` / `files` / `destination` 都被限制在会话工作区内。
- **`dryRun` 顺带做 zip-slip 检查**：条目里出现 `..`、绝对路径或盘符时整包拒绝，并报出问题条目名。
- **`convert` 要双倍磁盘**：实现方式是解压到临时目录再重新打包，大包请先确认空间。

## 已知限制

- **`diff` 只能按「名字 + 大小」比较**：同大小但内容不同的改动检测不到，输出里会明确写这一点。
- **加密封包列不出条目**：7z 加密包在 `list` 阶段就会要求密码，此时 `preview` / `diff` 拿不到数据。
- **没有修复和挂载**：`bz.exe` 是纯命令行压缩器，没有 repair、也没有挂载能力；损坏的包只能尽量解出可解的部分。
- **相对路径以会话工作目录为基准**，不是插件目录。
