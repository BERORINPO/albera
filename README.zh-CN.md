# ALBERA

ALBERA 的名称与精神源自安妮·阿尔伯斯（Anni Albers）的编织艺术。它的长期方向是一个开发平台，让人与多个 AI 一起把知识、代码和开发工作编织在一起。当前版本只是一个只读的本地仪表盘，用于查看 Claude Desktop / Claude Code 的会话：它把会话分成需要你回复、可能卡住、已完成但未读、运行中、最近、可归档几组，同时显示每个会话正在做什么、上下文用量的估算，并帮你准备交接。会话可以按列表查看，也可以在画布上查看，画布上每个项目一张纸。应用其他标签页中的聊天不会显示。

[English](README.md) · [日本語](README.ja.md) · 简体中文

> 非官方社区工具。与 Anthropic 没有隶属关系，也未获得 Anthropic 的认可或支持。Claude 是 Anthropic 的商标。

![ALBERA 演示数据：最上方是最先该回复的会话，右侧是各分组的计数，下面是各个分组](docs/screenshot.png)

演示数据。另见：[画布](docs/screenshot-canvas.png) · [深色主题](docs/screenshot-dark.png) · [400 px 宽](docs/screenshot-narrow.png) · [日语](docs/screenshot-ja.png)

- **只读。** 它只读取应用的会话文件，从不写入。它只监听 127.0.0.1，不会联系其他机器：唯一的一次请求，是在端口被占用时发给 127.0.0.1 上自己的端口，询问那里是否已经有一个看板（网络驱动器上的文件夹见[读取哪些内容](#what-it-reads)）。
- **背后没有 AI。** 分组、标签、上下文大小和画布布局都来自固定规则。不会向任何模型或其他地方发送任何内容。
- **零依赖。** 需要 Node.js 22 或更高版本。无需构建。
- **英语和日语。** 页面跟随浏览器语言，终端跟随系统语言。

## 长期方向（尚未实现）

以下是产品规划，不是本版本的功能：运行、监控和控制多个 AI CLI；由 Main AI 编排；无限画布和图视图；Knowledge Graph、Harness Graph 和 Comprehension Graph；Git worktree 与 PR 集成；以及人工介入、审批和开发策略的执行。当前版本不会执行或控制 agent，也不提供这些图或集成。

## 快速开始

你需要 Node.js 22 或更高版本和 Claude 桌面应用，且 Code 标签页中至少有一个会话。`albera` 包尚未发布到 npm；请按下面的克隆方法使用此分支。本 README 后面出现的 `npx albera` 命令适用于包发布之后。

克隆并运行当前源码：

```sh
git clone https://github.com/BERORINPO/pigeonholes.git albera
cd albera
npm start                       # same as: node src/entry/server.mjs
```

给脚本传参数时，npm 需要在参数前加 `--`：`npm start -- --port 8798`、`npm run demo -- --lang en`。不加的话，npm 会把该参数当作自己的参数。`node src/entry/server.mjs --port 8798` 则不需要。

当终端打印出 `ALBERA: http://127.0.0.1:8797 (read-only)` 时，在浏览器中打开该地址。首次扫描需要几秒钟。按 Ctrl+C 停止。如果打印的是 `Already running: open http://127.0.0.1:8797`，说明同类看板已经在运行，直接打开该地址即可。如果该端口上的看板是演示版而你要看自己的会话（或者相反），它会说明情况，并打印一条使用其他端口的命令。

如果想用合成数据体验而不读取你的会话，请运行：

```sh
npm run demo
```

提示：Claude 桌面应用有内置的浏览器窗格。在那里打开该地址，看板就会出现在对话旁边。列表和画布都可以缩到约 400 px 宽仍能使用。在该窗格中，桌面通知不可用，**Open** 也可能被拦截；此时请使用详情中的 **Copy link**，或在常用浏览器中打开看板。

<a id="what-it-reads"></a>
## 读取哪些内容

所有内容都以只读方式打开。不会向任何地方发送任何内容，也不会读取应用的设置、cookie 或凭据。

| 内容 | Windows | macOS | Linux |
|---|---|---|---|
| 会话列表（`<account>/<org>/local_*.json`、`archived-sessions.idx`） | `%APPDATA%\Claude\claude-code-sessions`，其次是 Microsoft Store 版的位置 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions` | `~/Library/Application Support/Claude/claude-code-sessions` | `$XDG_CONFIG_HOME/Claude/claude-code-sessions`，其次是 `~/.config/Claude/claude-code-sessions` |
| 对话记录（`<id>.jsonl`） | `%USERPROFILE%\.claude\projects` | `~/.claude/projects` | `~/.claude/projects` |

- 使用第一个存在的会话文件夹。`--sessions-dir` 会取代这一搜索。
- 对话记录：如果设置了 `CLAUDE_CONFIG_DIR`，则改用 `$CLAUDE_CONFIG_DIR/projects`。只读取每份对话记录的末尾，并且只针对最近 7 天内活跃的会话：读取最后 200 KB；如果这 200 KB 中没有可用的行或没有 token 计数（例如一条特别长的工具输出），则改为读取最后 2 MB。对于后台 agent，它会检查 `<id>/subagents/` 下的文件时间（并统计最近写入的文件数），但不会打开这些文件。
- 从对话记录末尾，它只使用这些信息：最后一轮的状态（以及 Claude 提问时的问题）、时间、最后一次回复和任何自动摘要的 token 计数、工具名称、正在编辑、写入或读取的文件的文件名（不含文件夹）、命令的程序名，以及 npm 或 git 等工具的子命令（`npm test`、`git log`；绝不包含路径、参数或值）、网页的主机名、连接器的名称、正在进行的计划步骤，以及 Claude 为其最后一条 shell 命令写的简短描述。工具结果和各工具输入的其余部分不会保留。文件名、步骤和描述会先经过一次清理（见[正在做什么](#doing-what)）。
- 会话的模型名称只用来推测其上下文窗口的大小。它不会被显示，也不会传到页面。
- 应用记录的该会话上下文耗尽的次数（一个数字）。它只用来决定卡住的会话是否提供 **Copy for a new session**。
- 每个会话运行所在的文件夹（已归档会话除外）：只检查该文件夹或其上层是否存在 `.git`，以及其直接子文件夹的名称。这用于给项目命名。网络路径（`\\server\share`、`//server/share`）会被跳过。映射的网络驱动器上的文件夹看起来与其他路径无异，因此看板检查时操作系统可能会访问该共享；每次检查在半秒后放弃。
- 它不使用的会话字段（例如 MCP 服务器设置）在读取后立即丢弃，不会传到页面。
- 页面会在此浏览器的存储中记住你的选择：语言、快捷键和通知开关、视图（列表或画布）、你展开了哪些分组和项目组、你在画布上放置每个项目纸张的位置，以及你复制过交接指令的会话（会话 ID、时间和百分比，保留 24 小时）。项目按其文件夹名称记忆；已不在看板上的项目对应的组会被移除，纸张的位置在其项目离开看板后保留 7 天。

## 六个分组

| 分组 | 含义 | 该做什么 |
|---|---|---|
| Needs you | Claude 提了问题、希望你批准计划，或说需要你 | 打开并回复。等待最久的排最前 |
| Stuck? | 出错、达到用量上限、启动失败，或 15 分钟没有进展 | 打开检查。如果毫无动静就重启 |
| Unread | 已完成，而你还没有打开查看结果 | 打开阅读 |
| Working | 正在运行 | 等待 |
| Recent | 最近 7 天内读过的 | 无需处理 |
| To archive | 闲置 7 天或更久的、定时任务的较早运行、重试过的尝试、PR 已全部合并或关闭的会话 | 选择、复制指令、粘贴到 Claude 中 |

顶部一行会指出最先该看的那个会话。计数列表（宽屏时在右侧，窄屏时在顶部一行下方）统计每个分组。**Open** 会在 Claude 应用中打开该会话。点击标题查看详情：它在做什么、上下文、完整摘要、文件夹、分支、PR、相关会话，以及复制 ID 或链接的按钮。页面在可见时每 5 秒刷新一次。Needs you 和 Stuck? 的桌面通知默认关闭，需在页脚中开启。

<a id="doing-what"></a>
## 正在做什么

Working 行（以及画布上的会话）带有一行简短文字，说明该会话正在做什么，内容取自它最后使用的工具："Editing board.mjs"、"Running tests (npm test)"、"Reading a page on example.com"、"2 helpers at work"、"Thinking"。Stuck? 行则说明它沉默之前在做什么："As of 3 hours ago: Reading notes.md"。

凡是 Claude 自己写的简短文字，标签都会显示出来：它所在的计划步骤（Step: Write the spec），以及用引号括起的、它为最后一条 shell 命令所写的描述（“Run the unit tests”）。显示之前，这些文字会先经过清理：去除控制字符和不可见字符，网址只保留主机名，绝对路径只保留文件名，ID、电子邮件地址、密钥以及任何看起来像密码或令牌的内容都会被抹去，文本被截断到 40 个字符。这些文字只留在这台电脑的屏幕上。

## 上下文与交接

最近 7 天内活跃的会话会显示其上下文有多满：即最后一次回复占用的上下文窗口比例（与应用自带的圆环显示的是同一个数字）。行内从第一级起就会显示；详情中始终显示，并附带 token 计数。只用文字和字重，没有进度条或颜色（画布上多了一个小的标尺刻度）：

| 级别 | 1M 窗口下 | 你看到的 |
|---|---|---|
| Notice | 约 58% 起 | `context 62%`（淡色） |
| Time to hand off | 约 80% 起 | `context 82% time to hand off`（粗体） |
| Soon | 约 90% 起 | `context 92% summarizes itself soon`（粗体） |

这些级别是相对于 Claude 自行总结对话的那个点来设定的（约为 1M 窗口的 97%），所以在 200K 窗口上它们来得更早（约 50%、69% 和 77%）。当窗口大小是猜测值时，数字显示为 `context ~62%`。总结之后的一小时内，该行显示 `summarized 5 min ago`。计数下方的 **Time to hand off: N** 会依次带你查看现在可以交接的会话，最满的排最前。

当上下文被填满时，Claude 会自行总结对话，并可能丢失细节。在此之前进行交接可以保留重要内容：会话在还掌握全部信息时写一份简报，新会话从这份简报开始。

1. 在处于 "time to hand off" 或更高级别的 Unread 或 Recent 行上（最近 24 小时内活跃），按 **Hand off**，或在该行上按 `h`（在 Unread 和 Recent 行上，任何上下文级别下 `h` 都有效）。详情会打开并显示一份简短的指引。
2. 按 **Copy and open**。看板会复制一条指令，并在 Claude 应用中打开该会话。
3. 把它粘贴到该会话中并发送。
4. Claude 在安全的位置停下，写出简报，并把简报连同新会话的工作位置，以及之后归档旧会话是否也会归档新会话一并展示给你。它会询问一次是否启动新会话，如果应用提供了新会话卡片，就用该卡片。
5. 你在应用中批准或拒绝。新会话随后会出现在看板上（若应用把两者关联起来，则作为旧会话的子会话），旧的行会显示 `hand-off copied 3 min ago`，直到其上下文再增长 5 个百分点、被总结，或过去 24 小时。

**为什么看板只复制一条指令。** 看板是只读的：它无法向会话中输入内容，也无法在应用中按任何按钮，这是有意为之。批准权留在你手里，在应用中进行，而由该会话自己的 Claude 凭借它所知道的一切来完成工作。复制的文本只包含百分比，不含标题或 ID，也不指定任何工具。只有 **Copy for a new session**（见下文）还会带上卡住会话的 ID。

Working 会话上没有 **Hand off** 按钮（粘贴会打断当前这一轮），Needs you 上也没有（那样会回答掉问题），停在用量上限的会话上同样没有；它们的行上会显示 "hand off after it finishes"、"answer its question first" 或 "hand off after the limit resets"。可能已满到无法回答的 Stuck? 会话则提供 **Copy for a new session**：在同一文件夹中启动一个新会话并粘贴到那里。该文本带有卡住会话的 ID，以便新会话读取它最近的对话记录（只读）并写出简报。

<details>
<summary>复制的交接指令</summary>

```
This conversation's context is about {pct}% full. Please get ready to continue this work in a new session, and don't start it until I approve.
1. Stop at a safe point. While doing this, don't change files, settings or other sessions, and don't archive this session. If you already handed this work off, just tell me where and stop.
2. Write a brief for the new session: the goal, what is done, what is in progress (files, branch, uncommitted changes), decisions and why, next steps, open questions.
3. Show me the brief. Say where the new session will work (this folder or a new worktree) and whether archiving this session later would also archive the new one. Then ask me once whether to start it, with the app's new-session card if you have one, and wait.
4. Only if I approve: start one new session with a fresh context (not a fork of this conversation) and the brief as its task. If you can't start sessions, give me the brief in one code block to paste.
5. If I decline, do nothing. If I'd rather compact here, give me one line to type after /compact.
Do nothing else.
```

</details>

## 画布

![演示数据的画布：每个项目一张纸，每个会话是一张便条，上面有时间、它在做什么以及上下文，底部是带图例和缩放的工具栏](docs/screenshot-canvas.png)

按 `v`（或计数下方的 **Canvas**）可把同一个看板看作一张铺满纸的桌面：每个项目一张纸，每个需要关注的会话（Needs you、Stuck?、Unread、Working）一张便条。再按一次 `v` 回到列表；页面会记住你上次使用的视图。

- **布局是固定规则，不是 AI。** 纸张按紧急程度排列：会话等你最久的那个项目在左上角。在一张纸上，Needs you 和 Stuck? 排最前，然后是 Unread 和 Working，顺序与列表相同；子会话会标出其父会话（"↳ Parent: …"）。Recent 和 To archive 合成纸张底部的一行（"Recent 4  To archive 13"）；点击它可在列表中打开该分组。只有待归档会话的项目，会集中列在纸张下方的一个区块里。每一行便条的高度取决于其内容。同一个看板总是给出同样的画面，因此你可以记住东西在哪。
- **三档缩放。** 远（低于 60%）：只显示标记，以及每个项目名旁边有多少会话需要你。中：标题、时间、运行中或卡住的会话正在做什么，以及重要时的上下文。近（100% 及以上）：还会显示分支、worktree、PR、父会话、问题或完整的 doing 行，以及 **Open** 和 **Hand off**。窄窗口（Claude 的侧边窗格）以近档打开，缩小时直接跳到远档。
- **移动视图。** 拖动桌面或用滚轮平移；Ctrl + 滚轮或双指捏合缩放。画布打开时定位在紧急的纸张上（左上角），缩放到一张纸能放进窗口的大小。`f` 适应全部内容，`z` 在那个视图和你之前所在的视图之间切换，`+` `−` 缩放，`0` 为 100%。
- **移动纸张。** 拖动项目名，或点按项目名调出移动该纸张的按钮（在项目名上按 Shift + 方向键效果相同）。其他纸张只会向下移动来腾出位置，不会横向移动。位置保存在此浏览器中；新项目会找一个空位，不会移动其他纸张。**Rearrange** 会重新排布所有内容。
- 底部的**工具栏**包含图例、缩放和 Fit all（缩放不会低于 30%，以保证名称可读；更长的桌面通过滚动来查看）。点击标题（或按 Space）即可在那里查看该会话的详情，**Hand off** 会在那里打开交接指引。
- 筛选会让不匹配的内容变暗，而不是移动任何东西。选择和归档仍在列表中进行。

画布取代了 0.1 版的 Overview。

## 快捷键

| 键 | 列表 | 画布 |
|---|---|---|
| `j` / `k` | 下一行 / 上一行 | 下一个 / 上一个会话，逐张纸 |
| `Enter` 或 `o` | 在 Claude 应用中打开会话 | 相同 |
| `Space` | 显示或隐藏详情 | 在工具栏中显示或隐藏详情 |
| `h` | 交接：打开指引并聚焦 **Copy and open**（按 Enter 即可按下） | 相同，在工具栏中 |
| `v` | 切换到画布 | 切换到列表 |
| `z` | 切换到画布并显示全部 | 显示全部 ⇄ 回到之前所在的位置 |
| `+` `−` `0` `f` | — | 放大、缩小、100%、适应全部内容 |
| 方向键 | `↓` / `↑`：下一行 / 上一行 | 在会话上：朝该方向相邻的会话。其他位置：平移 |
| `Shift` + 方向键 | — | 在项目名上：移动其纸张 |
| `x` | 在 To archive 中选中或取消选中一行 | — |
| `a` | 选中所有建议的行 | — |
| `c` | 复制归档指令（接下来的 50 个） | — |
| `/` | 筛选 | 相同 |
| `1`–`6` | 跳到某个分组 | 跳到某个分组的第一个会话（`6` 会在列表中打开 To archive） |
| `?` | 所有按键 | 相同 |
| `Esc` | 依次：关闭对话框、退出筛选、关闭详情，然后清除筛选 | 依次：关闭对话框、退出筛选、关闭工具栏、退出会话或项目名，然后清除筛选 |

单字母快捷键可以在 `?` 对话框中关闭；Enter、Space、Esc、Tab 和方向键仍然有效，画布工具栏上有其余功能的按钮。

## 归档旧会话

看板从不更改任何东西。它改为为 Claude 写一条指令。

1. 在 **To archive**（列表中）里，勾选 **Select all N suggested**，或逐行挑选。
2. 按底部栏中的 **Copy instruction**。它一次复制 50 个会话：三行指令，然后每行一个会话 ID（不含标题）。
3. 把它粘贴到 Claude 桌面应用的某个会话中并发送。Claude 会归档这些会话，并回复归档和跳过了多少个。如果它请求权限，请在该聊天中允许。
4. 已归档的会话会在下次刷新时离开看板。底部栏会统计已完成的数量。

为什么只给一条指令：这些文件归应用所有，应用一直在重写它们。从外部写入可能与应用产生竞争并损坏文件。通过 Claude 归档使用的是应用自己的方式，并且每一步你都能看到并批准。

归档不会删除任何东西；你可以在 Claude 应用中恢复任何会话。建议会排除有未关闭 PR、已置顶、带 "keep" 标记、最后一份报告未读，或仍有子会话在使用的会话。这些行仍然可以手动选择。如果应用的文件格式看起来有变（许多会话没有日期），建议功能会关闭，并有提示说明原因。

<a id="compatibility"></a>
## 兼容性

- **未公开文档的文件。** ALBERA 读取的是桌面应用的本地文件，它们不是公开 API。应用更新可能改变这些文件，导致看板出问题，或把会话放进错误的分组。如果无法再读取 token 计数，看板会隐藏上下文数字；如果无法读取工具使用情况，doing 标签就会缺失。两种情况下页脚都会提示。请附上你的应用版本提交 issue。
- **上下文大小是估算值。** 没有任何文件说明会话上下文窗口的大小。看板根据模型名称（`[1m]`）、对话记录能证明的内容，或已知的模型系列来取值，猜测时会写上 `~`。200K 窗口在哪里自行总结也是估算，而且在出现特别大的工具结果时，计数可能滞后。
- **新会话卡片。** 交接依赖于会话中的 Claude 通过应用的新会话卡片来询问，这是一个未公开文档的应用功能。如果没有该卡片，Claude 会把简报放在代码块里给你，供你粘贴到新会话中。
- **打开链接。** Open 使用应用的 `claude://` 链接。这是尽力而为的：某些浏览器和内嵌窗格会拦截它。请改用详情中的 **Copy link** 或 **Copy ID**。
- **平台。** 在 Windows 上开发（包括 Microsoft Store 安装版）。macOS 的文件夹是应用的标准位置。Linux 路径未经测试；如果你的文件夹在别处，请反馈。测试套件使用合成数据，在 Windows、macOS 和 Linux 上运行。
- **远程会话。** 在云端或另一台机器上运行的会话，在这台电脑上没有对话记录，因此无法检测其 Working、Stuck?、doing 标签和上下文。页脚会说明有多少个。

## 配置

命令行参数优先于环境变量。`--flag value` 和 `--flag=value` 两种写法都可以。

| 参数 | 环境变量 | 默认值 |
|---|---|---|
| `--port <n>` | `ALBERA_PORT` | `8797`（1024–65535） |
| `--lang en\|ja` | `ALBERA_LANG` | 你的系统语言。设置终端消息和演示内容 |
| `--demo` | `ALBERA_DEMO=1` | 关闭 |
| `--sessions-dir <path>` | `ALBERA_SESSIONS_DIR` | 自动搜索（见[读取哪些内容](#what-it-reads)） |
| `--projects-dir <path>` | `ALBERA_PROJECTS_DIR` | `$CLAUDE_CONFIG_DIR/projects`，否则 `~/.claude/projects` |
| — | `ALBERA_ROOTS` | 你的主目录。以 `;` 分隔的绝对路径（macOS 和 Linux 上用 `:`）。位于 `<root>/<name>/...` 且不在任何 git 仓库内的会话，会归入 `<name>` 组 |
| `--help`, `--version` | — | — |

当对应的 `ALBERA_*` 变量未设置或为空时，也会读取之前的 `PIGEONHOLES_*` 环境变量。非空的 `ALBERA_*` 值优先。

项目以会话所运行的 git 仓库命名。`.claude/worktrees/` 下的 worktree 算作其所属仓库。

页面地址支持 `?lang=en` 或 `?lang=ja`、`?theme=light` 或 `?theme=dark`，以及 `?view=list` 或 `?view=canvas`（这一项不会被记住）。页眉中的语言按钮会在此浏览器中记住你的选择。上下文级别和其他阈值是 `src/shared/constants.mjs` 中的常量；没有设置界面。

## 故障排查

| 你看到的 | 怎么做 |
|---|---|
| `Port 8797 is used by another app` | 换一个端口启动。消息会打印一条可直接粘贴的命令（例如 `npx albera --port 8798`）；它会保留你用过的其他参数，比如 `--demo` |
| `Port 8797 has the demo board, not your sessions`（或相反） | 在另一个看板的终端中按 Ctrl+C 停止它，或粘贴打印出的使用其他端口的命令 |
| `Can't find the Claude desktop app's session folder` | 在 Claude 桌面应用的 Code 标签页中启动一次会话，或传入 `--sessions-dir <path>`。应用其他标签页中的聊天不会创建这个文件夹。消息中会列出它尝试过的所有文件夹 |
| 页面提示无法连接到服务器 | 终端被关闭了。重新启动它；页面会自动重新连接 |
| **Open** 没有反应 | 浏览器拦截了 `claude://` 链接。请使用详情中的 **Copy link** 或 **Copy ID**，或在另一个浏览器中打开看板 |
| 页脚提示通知被阻止 | 此浏览器不允许该页面使用通知（Claude 的内置窗格就是如此）。请在常用浏览器中打开看板以使用通知 |
| **Copy instruction** 或 **Copy and open** 弹出一个文本框 | 这里无法自动复制。在文本框中按 Ctrl+C（macOS 上按 Cmd+C） |
| 一个运行中的会话出现在 **Stuck?** 下 | 它在等待权限提示，或正在执行一个耗时超过 15 分钟的步骤。打开查看 |
| 一个会话在你已在此读过之后仍保持 **Unread** | 在 Claude 应用中打开它一次。看板无法把它标为已读 |
| 一个已满的会话上没有 **Hand off** 按钮 | 它只在 Unread 和 Recent 行上显示，从 "time to hand off" 起，且仅限最近 24 小时内活跃的会话。在该行上按 `h`：看板会说明原因，或打开指引 |
| 上下文显示为 `~` | 窗口大小是猜测值（见[兼容性](#compatibility)） |
| 页脚提示未找到对话记录文件夹 | Working、Stuck?、doing 标签和上下文都需要对话记录。传入 `--projects-dir <path>` 或设置 `CLAUDE_CONFIG_DIR` |
| 页脚提示无法读取上下文大小或工具使用情况 | 对话记录格式可能已改变，因此这些标签被隐藏。请附上你的应用版本提交 issue |
| 一条提示说应用的文件格式可能已改变 | 出于安全考虑，建议功能已关闭。请附上你的应用版本提交 issue |

## 开发

```sh
npm test          # unit and integration tests (node:test, synthetic data only)
npm run arch      # dependency direction, forbidden APIs, words only in the dictionaries
npm run smoke     # reads this computer's real sessions read-only on a random port; prints counts only
npm run demo      # the board with synthetic data
```

规格文档：[spec/board.md](spec/board.md)（数据与规则，日语）、[spec/ui.md](spec/ui.md)（界面）、[spec/design.md](spec/design.md)（外观）、[spec/architecture.md](spec/architecture.md)（分层与决策，日语）。测试名称和许多代码注释同样是日语。安全问题报告：[SECURITY.md](SECURITY.md)。变更记录：[CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
