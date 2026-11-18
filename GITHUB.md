# 发布到 GitHub 的清单（dsh-bandizip）

> 本文件只是发布操作说明。**准备阶段不执行其中任何命令**；确认无误后由维护者手动发布。

## 建议的远端仓库

- 仓库名：`dsh-bandizip`
- 描述：`DeepSeek Harness plugin that drives the local Bandizip console tool (bz.exe) to create, extract, list, test, preview, diff, browse and convert archives.`
- License：MIT
- 建议 topic：`deepseek-harness`、`dsh-plugin`、`bandizip`、`archive`

## 发布前要改的占位符

- `package.json` 的 `repository.url` / `bugs.url` / `homepage` 目前指向 `https://github.com/dafeiyu/dsh-bandizip.git`，确认 GitHub 用户名 `dafeiyu` 与仓库名无误；若实际账号不同，全局替换 `dafeiyu/dsh-bandizip`。
- `LICENSE` 的版权行为 `Copyright (c) 2026 dafeiyu`，确认年份与署名。
- `README.md` 安装段落里的 `name: '@local/bandizip'` 与 `package.json` 的 `name` 必须一致（当前一致）。
- 确认 `node_modules/@deepseek-ai/schemastery` 与 `node_modules/@deepseek-ai/cosmokit` 两个 vendored 目录已随仓库提交且未被 `.gitignore` 排除——这是本插件能用设置页的前提。

## 发布命令（仅文档，勿在此阶段执行）

```bash
cd bandizip-plugin
git add -A && git commit -m "chore: prepare dsh-bandizip for GitHub release"
git remote add origin https://github.com/dafeiyu/dsh-bandizip.git
git push -u origin main
```

若仓库已有 tag 或需要指定首次提交，可按需调整提交信息；发布 tag：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 建议的 tag 名

- `v1.0.0`（与 `package.json` 的 `version` 一致）

## 发布后核对

- GitHub 仓库页面的 License 被识别为 MIT。
- `README.md` 渲染正常，工具清单与配置项表格齐全。
- 仓库包含 vendored 依赖目录，用户 `link:` 安装后可直接在插件页设置 `bzPath`。
