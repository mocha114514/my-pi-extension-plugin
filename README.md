# Mocha

A Chinese/English extension suite for [Pi](https://github.com/earendil-works/pi), focused on the terminal conversation experience.

面向 [Pi](https://github.com/earendil-works/pi) 的中英文扩展套件，提供终端界面增强、对话导航、回复计时与用量统计。

[English](#english) | [简体中文](#简体中文)

## English

A lightweight extension suite that polishes Pi's shell interface.

Built entirely on Pi's own extension mechanism — zero source modification, easy to attach and remove.

> **Fullscreen mode strongly recommended** (set TUI mode to full screen in `/settings`) for the best experience.

### Interface Optimization

Compact tool output, expandable details, Markdown rendering enhancements, and more.

While a response is executing:

![Executing view](assets/executing-view.png)

The finished round collapses automatically:

![Auto collapse](assets/auto-collapse.png)

Double-click to expand:

![Double click expand](assets/double-click-expand.png)

### Turn Navigator

Adds a navigator on the right side to quickly review each round's user prompt and jump to it with a click.

![Turn navigator](assets/turn-navigator.png)

### Statusline

An improved version of Pi's native statusline.

Shows model, project, Git and token usage information, among other data.

![Statusline](assets/statusline.png)

### Usage

Token usage, costs, daily totals and model price editing.

![Usage and costs](assets/usage-costs.png)

![Daily usage](assets/usage-daily.png)

### Keyboard Shortcuts

- Ctrl+C no longer clears the input box text.
- With mouse-selected text, Ctrl+C copies it instead of quitting Pi; pressing Ctrl+C with nothing selected asks for confirmation first to prevent accidental exits.
- With mouse-selected text, direct deletion (Backspace / Delete) and overwrite (Ctrl+V) are supported.
- With mouse-selected text, line cutting (Ctrl+X) is supported.
- Ctrl+- / Ctrl+_ for undo; Windows additionally supports Ctrl+Z.

Note: the TPS plugin comes from the official [Pi](https://github.com/earendil-works/pi) repository implementation.

### Install and Update

```bash
pi install git:github.com/mocha114514/my-pi-extension-plugin
pi update git:github.com/mocha114514/my-pi-extension-plugin
```

### Uninstall

```bash
pi remove git:github.com/mocha114514/my-pi-extension-plugin
```

Then manually delete `~/.pi/agent/mocha-cache/` if you want a full cleanup.

### Commands

| Command              | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `/m-mng`             | Enable or disable extensions you like/dislike  |
| `/m-mng list`        | List plugin states                             |
| `/m-lgg`             | Chinese/English selection                      |
| `/m-usg` / `/-usg n` | View usage and cost statistics                 |

### Data Location

- Configuration, plugin switches and usage data are stored in **`~/.pi/agent/mocha-cache/`**, separate from the installation directory. Follows `PI_CODING_AGENT_DIR` when set; project-level installations also use the same user data directory.

## 简体中文

一个轻量化的优化pi的外壳界面的插件集合。

完全依赖于pi自身的扩展机制，零源码修改，轻量装卸。

> **强烈建议在 pi 的全屏模式（在 `/settings` 的 TUI mode 中选择 full screen）下配合使用该插件，以获得最好效果。**

### 界面优化

紧凑工具输出、详情展开、 Markdown 渲染增强等。

执行中界面优化

![Executing view](assets/executing-view.png)

本轮执行完毕后会自动进行折叠

![Auto collapse](assets/auto-collapse.png)

可双击展开

![Double click expand](assets/double-click-expand.png)

### 轮次导航

在右侧添加轮次导航，可以快速查看每轮的用户指令并点击转跳

![Turn navigator](assets/turn-navigator.png)

### 状态栏

状态栏在pi原生的基础上进行一定改善

模型、项目、Git 和 Token 用量信息等各类数据显示。

![Statusline](assets/statusline.png)

### 用量统计

Token 用量、费用、每日汇总和模型价格编辑。

![Usage and costs](assets/usage-costs.png)

![Daily usage](assets/usage-daily.png)

### 快捷键优化

- 取消了Ctrl+C清空输入框文本的行为。
- 支持鼠标自由选中文本的情况下进行Ctrl+C复制而不是退出pi，并且对没选中内容时候按下Ctrl+C做了二次确认防止误触推出pi。
- 支持鼠标自由选中文本的情况下进行文本的直接删除（Backspace / Delete）和覆写（Ctrl+V）。
- 支持鼠标自由选中文本的情况下行文本的剪切操作（Ctrl+X）。
- Ctrl+- / Ctrl+_进行撤销操作，Windows端额外支持Ctrl+Z。

注：TPS插件源自于[Pi](https://github.com/earendil-works/pi)官方仓库实现。

### 安装与更新

```bash
pi install git:github.com/mocha114514/my-pi-extension-plugin
pi update git:github.com/mocha114514/my-pi-extension-plugin
```

### 卸载

```bash
pi remove git:github.com/mocha114514/my-pi-extension-plugin
```

然后手动删除 `~/.pi/agent/mocha-cache/` 即可彻底清理。

### 常用指令

| 指令                 | 用途                          |
| -------------------- | ----------------------------- |
| `/m-mng`             | 启用和禁用你喜欢/不喜欢的扩展 |
| `/m-mng list`        | 查看插件状态                  |
| `/m-lgg`             | 中文/英文选择                 |
| `/m-usg` / `/-usg n` | 查看用量与费用统计            |

### 数据位置

- 配置、插件开关和用量数据统一保存在 **`~/.pi/agent/mocha-cache/`**，与安装目录分离。设置 `PI_CODING_AGENT_DIR` 时会跟随该目录；项目级安装也使用同一用户数据目录。


## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
