# 高效模式 · DSH Agent 预设插件

一个 DeepSeek Harness（dsh）插件包。它向 Agent 预设名册注册一个名为 **高效模式** 的预设，
预设的基础提示词就是 `~/Documents/System prompt.md` 的正文，其中的 `[]` 占位符不再写死，
而是每次组装提示词时由本插件注册的提示词变量实时填充。

- 预设 id：`efficient`
- 预设名称：`高效模式`
- 基础提示词：模板 115 行，含 11 个动态引用，全部由本包的 Host 插件提供
- 依赖：仅 Node 内置模块，安装时不需要拉取任何 npm 包

## 它解决什么问题

原文件里这些位置是示例值或空位：`Current branch: [branch]`、`Git user: [user_name]`、
`[commits(3)]`、`` `[XXX]` ``、`Platform: [darwin]`、`Today's date is [2026-09-27].`。
照抄会把 `darwin`、`2026-09-27` 这类示例值固化进提示词。这里把它们换成提示词变量，
渲染时取真实值：

| 原模板占位符 | 提示词变量 | 取值来源 |
|---|---|---|
| `Current branch: [branch]` | `{{git_branch}}` | `git symbolic-ref --short -q HEAD`，分离头指针时退化为短 SHA |
| `Main branch …: [branch]` | `{{git_main_branch}}` | `origin/HEAD` → 本地 `main` → 本地 `master` → 当前分支 |
| `Git user: [user_name]` | `{{git_user}}` | `git config user.name` |
| `Status:` 下的 `(clean)` | `{{git_status}}` | `git status --porcelain`，工作区干净时输出仍是 `(clean)` |
| `[commits(3)]` | `{{git_commits}}` | `git log -n3 --pretty=format:'%h %s'` |
| `` `[XXX]` `` | `{{working_directory}}` | 该会话的工作目录 |
| `Is a git repository: [true]` | `{{is_git_repository}}` | `true` / `false` |
| `Platform: [darwin]` | `{{platform}}` | `process.platform` |
| `Shell: [shell]` | `{{shell}}` | 非 Windows 为 `bash`，Windows 为 `pwsh` |
| `OS Version: [OS]` | `{{os_version}}` | `os.type()` 加 `os.release()` |
| `Today's date is [2026-09-27].` | `{{today}}` | 宿主本地日期 `YYYY-MM-DD` |

模板里唯一保留的方括号是正文自带的 Markdown 链接示例 `[foo.ts](src/utils/foo.ts)`
和 `[Bar.tsx:42](app/components/Bar.tsx:42)`，它们不是占位符。

## 目录结构

```
better-system-prompt/
├── package.json           # bundle 清单：dsh.bundle.patch、locale 与 icon 导出
├── cordis.patch.yml       # 预设声明 + persona 模板 + 工具行（由脚本生成）
├── index.js               # Host 插件：注册 11 个提示词变量
├── locale/
│   ├── en.json            # 插件清单里的标题与描述（英文）
│   └── zh.json            # 同上（中文）
├── icon.svg               # 插件图标
├── scripts/
│   ├── build-patch.mjs    # 从基础提示词文件重新生成 cordis.patch.yml
│   └── verify.mjs         # 离线自检：变量覆盖、渲染、快照稳定性
└── README.md
```

## 安装

用 dsh 的插件管理器安装这个目录（需要 Full access 或逐次批准）：

```
plugin_manager install_bundle  target=<本目录绝对路径>
```

安装后 `cordis.patch.yml` 里的 `preset-efficient` 行进入 Loader，预设名册出现
「高效模式」。新建会话时在选择器里选它即可；也可以把它设为新会话默认预设。

## 工作原理

三件事拼在一起：

1. **基础提示词是 persona 模板。** 预设挂载 `@deepseek-ai/dsh-persona`，把整份模板放进
   `prefix`，并设置 `complete: true`。于是渲染后的 prefix 就是这个 Agent 的**全部**系统
   提示词，模板本身定义了它的身份，其它插件贡献的系统提示词 section 不再追加。
2. **`[]` 的内容由提示词变量提供。** 模板里的 `{{...}}` 由 `ctx.systemPrompt.variable()`
   注册的 provider 在每次组装时求值。注册表对引用是**严格**的：引用了未注册的变量、
   或 provider 返回 `undefined`，整个提示词组装会直接报错，而不是渲染成空字符串。
   所以 `index.js` 里所有 provider 都保证返回字符串。
3. **git 事实每会话采样一次。** provider 必须是同步函数（插值发生在组装过程中），因此
   `index.js` 用 `execFileSync` 调用 git，并给整次探测设了 3 秒总预算；失败、超时、非仓库
   目录都会降级为占位文本。第一次组装时采样，之后按会话 id 复用，所以同一会话内提示词
   逐字节稳定——既符合模板里“snapshot in time, and will not update during the
   conversation”的措辞，也让 provider 的前缀缓存保持可复用。

## 预设包含的能力行

工具与服务的组成对齐随 dsh 发布的 `standard` 预设，这样“高效模式”是一个能直接干活的
模式，而不是只有身份的壳：bash / pwsh（按平台二选一）、文件读写、glob/grep、后台任务、
定时提醒、技能、goal、压缩（compaction）与工具结果裁剪、子代理（spawn 与 fork）、web、
todo、ask_user_question、present。

刻意没有挂载的行：

- `@deepseek-ai/dsh-plan-mode`：它面向模型的唯一作用就是一段策略 section，而
  `complete: true` 会把这类 section 全部丢弃。挂上它，界面上的 plan 开关只会切换状态、
  不告诉模型任何事，是明确的陷阱，所以不挂；此时 composer 的计划按钮本来就不出现。
  另外它的 Config 要求非空 `section`，缺了会在加载时报错。
- `@deepseek-ai/dsh-agent-instructions`：它把 `AGENTS.md` 作为一条 user 消息注入，而模板
  已经逐字包含了 `~/.dsh/AGENTS.md` 的内容，挂载会让同一份指令出现两次。模板里那段是
  源文件的快照，不是实时读取。
- `@deepseek-ai/dsh-time-context`：模板自带 `Today's date`，再挂一个时间上下文会重复。
- `workflow` / `ralph` 与 codex、claude-code 子代理后端：保持组成精简。

## 修改基础提示词

模板是生成出来的，不要直接改 `cordis.patch.yml` 里的 prefix 块：

```
node scripts/build-patch.mjs "/path/to/System prompt.md"
```

脚本按固定映射替换占位符（映射表在 `scripts/build-patch.mjs` 的 `REPLACEMENTS`），
任何一条匹配不上就报错退出，避免静默漏替换。改完重新安装 bundle，新会话才会用上；
已经开着的会话保留它启动时的插件版本。

只想调整 git 事实的细节（例如列出几条最近提交），可以给 `prompt-facts` 行加配置：

```
          - id: prompt-facts
            name: '@local/dsh-efficient-mode'
            config:
              commitCount: 5
```

## 验证

离线自检（不需要运行中的 Harness）：

```
node scripts/verify.mjs
```

它会用桩上下文执行 `apply()`、从 `cordis.patch.yml` 抽出模板、核对模板引用与注册变量
是否一一对应、渲染一遍并复查同一会话两次组装结果一致，最后打印渲染后的完整提示词。
任何一项不通过就以非零码退出。

安装后另需确认两点：插件管理器返回 `application: applied`；以及预设名册里出现
`efficient` 行（可用 `cordis_inspect_query` 查 `Config.listConfigs`，过滤
`@deepseek-ai/dsh-agent-preset`）。会话内实际渲染出来的提示词只能在选中该预设的新会话里
确认。

## 已知限制

- **同步探测**：git 调用是同步的，整次探测最长占用 3 秒（仅每会话首次组装时）。git 缺失、
  目录不是仓库、或超时都会降级为 `(not a git repository)` 一类占位文本，不会让提示词失败。
- **每会话一份快照**：会话中途新建的提交不会反映到提示词里，这是模板文案的既定语义。
  想强制刷新，开新会话即可。
- **`complete: true` 的代价**：其它插件贡献的系统提示词 section（含工具使用指引）不会出现；
  工具本身仍可用，其说明通过工具 schema 传给模型。
- **未声明 Config schema**：profile 安装的 bundle 无法从 dsh 安装目录解析 `schemastery`，
  所以这个包不 import 任何 harness 包，行配置以未校验的普通对象读取（只认 `commitCount`）。
- **`files` 字段对目录直装不生效**：dsh 直装本地目录时是以链接方式安装，改动源码后需要重新
  安装并重启才能加载新的 JS 模块版本。

## 环境

- dsh 0.2.0-rc.2（Desktop，`desktop` profile）
- Node.js ≥ 18（仅用到内置模块 `node:child_process`、`node:os`）
- `git` 在 PATH 中（缺失时退化为占位文本）
