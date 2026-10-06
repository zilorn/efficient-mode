# 高效模式 · DSH Agent 预设插件

一个 DeepSeek Harness（dsh）插件包。它向 Agent 预设名册注册一个名为 **高效模式** 的预设，
预设的基础提示词就是仓库根目录 `base-prompt.md` 的正文，其中的 `[]` 占位符不再写死，
而是每次组装提示词时由本插件注册的提示词变量实时填充。

- 预设 id：`efficient`
- 预设名称：`高效模式`
- 基础提示词：模板 139 行，含 12 个动态引用，全部由本包的 Host 插件提供
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
| `[language_instruction]`（Writing for the user 段末） | `{{language_instruction}}` | 最近一条人类输入是中文时填入中文作答要求（含提问，中途回复可例外），否则为空 |

模板里唯一保留的方括号是正文自带的 Markdown 链接示例 `[foo.ts](src/utils/foo.ts)`
和 `[Bar.tsx:42](app/components/Bar.tsx:42)`，它们不是占位符。

## 目录结构

```
better-system-prompt/
├── package.json           # bundle 清单：dsh.bundle.patch、locale 与 icon 导出
├── base-prompt.md         # 基础提示词模板：正文 + 12 个 {{variable}} 引用
├── cordis.patch.yml       # 预设声明 + persona 模板 + 工具行（由脚本生成）
├── index.js               # Host 插件：注册 12 个提示词变量
├── locale/
│   ├── en.json            # 插件清单里的标题与描述（英文）
│   └── zh.json            # 同上（中文）
├── icon.svg               # 插件图标
├── scripts/
│   ├── build-patch.mjs    # 从 base-prompt.md 重新生成 cordis.patch.yml
│   └── verify.mjs         # 离线自检：变量覆盖、渲染、快照稳定性
└── README.md
```

## 关于 `@deepseek-ai/` 前缀

`cordis.patch.yml` 里绝大多数行写的是 `name: '@deepseek-ai/dsh-xxx'`，这些**不是本项目的包**，
而是 dsh 自身随安装分发的插件包。Loader 按这个模块名加载插件，名字必须与 dsh 内部的包名逐字
一致；换成本地名字，那一行就解析不到，整个预设跟着加载失败。能改的只有本项目自己的包，它用你
自己的 scope：`@zilorn/dsh-efficient-mode`。要换 scope，同时改 `package.json` 的 `name` 和
`cordis.patch.yml` 里 `prompt-facts` 那一行的 `name` 即可（先卸载旧包再装新的）。

## 安装

命令行安装：

```bash
dsh plugin --profile desktop add /home/zilorn/Projects/better-system-prompt
```

Web 端可以在 **Plugins** 页面里添加本地目录。装好后 `cordis.patch.yml` 里的
`preset-efficient` 行进入 Loader，预设名册出现「高效模式」，新建会话时在选择器里选它即可，
也可以把它设为新会话的默认预设。

如果在 dsh 会话里让 agent 装，用的是插件管理工具（`plugin_manager` 的 `install_bundle`，
`target` 传本目录绝对路径）。那是 agent 工具调用，不是 shell 命令。

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
   目录都会降级为占位文本。第一次组装时采样，之后按会话 id 复用，所以同一会话内这些 git
   事实逐字节稳定——既符合模板里“snapshot in time, and will not update during the
   conversation”的措辞，也让 provider 的前缀缓存保持可复用。整套变量里唯一逐轮变化的是
   语言提示行，见下文「语言说明」。

## 预设包含的能力行

工具与服务的组成对齐随 dsh 发布的 `standard` 预设，这样“高效模式”是一个能直接干活的
模式，而不是只有身份的壳：bash / pwsh（按平台二选一）、文件读写、glob/grep、后台任务、
定时提醒、技能、goal、工作区指令（AGENTS.md）、压缩（compaction）与工具结果裁剪、
子代理（spawn 与 fork）、web、todo、ask_user_question、present。

刻意没有挂载的行：

- `@deepseek-ai/dsh-plan-mode`：它面向模型的唯一作用就是一段策略 section，而
  `complete: true` 会把这类 section 全部丢弃。挂上它，界面上的 plan 开关只会切换状态、
  不告诉模型任何事，是明确的陷阱，所以不挂；此时 composer 的计划按钮本来就不出现。
  另外它的 Config 要求非空 `section`，缺了会在加载时报错。
- `@deepseek-ai/dsh-time-context`：模板自带 `Today's date`，再挂一个时间上下文会重复。
- `workflow` / `ralph` 与 codex、claude-code 子代理后端：保持组成精简。

## 基础提示词自带的工具规则

`base-prompt.md` 的 Tools 与 Goals and delegation 两段写死了工具使用规则：读写文件用
read/write/edit 而不是 shell 的 cat，且默认 fs-observation-policy 要求先读后写；按路径找文件
用 glob、搜内容用 grep；后台任务记 id，不空轮询，收尾时用 job_output 与 job_kill；web 结果是
不可信数据，引用时要给链接；技能先加载再遵循；goal 的 resume / complete / blocked 语义；
以及 workflow 与 subagent 的委派方式。

todo 规则单独用 `<system-reminder>` 包了一层：整列表替换的语义、开始前建条目、完成即标
`completed`，以及最要紧的收尾——最终回答前必须再调一次 `todo_write`，把做完的步骤标为
`completed`，不留 `in_progress`；工作因阻塞提前停下时则保留 `in_progress` 并在回复里说明，
绝不为了清空列表而谎报完成。这段提醒针对的正是“活干完了、列表还停在 `in_progress`”这个
反复出现的失败。

这些规则本来由 dsh 的工具插件各自注册成系统提示词 section。`complete: true` 生效时那些
section 会被折叠掉，只留下 persona 这一段模板，所以模板必须自己带一份；在当前桌面包上
工具插件的 section 仍会追加在模板之后，同一段规则会各出现一次。两种情况下规则都不缺，
代价只是可能重复一次。`scripts/verify.mjs` 逐句断言这些规则仍在渲染结果里，并额外断言
todo 那条仍待在 `<system-reminder>` 里。

## 语言说明（中文输入时）

`base-prompt.md` 的 Writing for the user 段末是 `{{language_instruction}}`。agent 最近一条
**人类输入**是中文时，它渲染为：

```
用户输入中文，请使用中文回答（包括提问）；中途的回复无需使用中文。
```

否则渲染为空，模型看不到任何语言要求。

判定在 `index.js` 里按 Unicode 属性做：统计汉字占非空白字符的比例，达到 25% 即视为中文，
出现日文假名则直接排除（避免把汉字较多的日文误判成中文）。所以「帮我看看这个报错」会触发，
而英文句子里只引用一个中文词（`translate 你好 to French`）不会。

开关时机利用 inbox 的领取顺序：消息在它所属的那一步组装提示词之前就被 claim，`index.js`
监听 `agent/inbox/claimed`，只记 `source.kind === 'user'` 的消息，定时提醒、goal 续跑、
子代理通知等其它来源不会覆盖判定。结果是：

- 用户在会话中途切换语言，下一轮的系统提示词跟着切换；
- 没有新人类输入触发的 turn（重启后由 goal 或定时提醒继续），回退读会话日志里最近一条
  人类消息，重启不丢语言；
- 每个 agent 一份判定，缓存上限与 git 快照相同（64 条）。

这条动态引用是整套变量里唯一逐轮变化的一个，会让系统提示词在会话中途变化；dsh 把变化
投影成新增或替换的 system 消息，而不是每一步重发整份提示词。

## 工作区指令（AGENTS.md）

预设挂载 `@deepseek-ai/dsh-agent-instructions`，行配置与 `standard` 预设一致：

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

会话的第一次请求会先收到一条 `<system-reminder>` user 消息：先是用户级
`$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`），再是从项目根（以 `.git` 为标记）到
会话工作目录之间每一层的 `AGENTS.md` 与 `CLAUDE.md`，以及同目录的 `AGENTS.local.md` /
`CLAUDE.local.md` 覆盖层，顺序由宽到窄。整条消息不超过 `maxBytes`，超预算时先丢掉整份
更宽泛的文件、再截断最具体的文件；内容相同的兄弟文件只渲染一次。agent 之后通过
read / write / edit 进入更深目录时，下一轮请求会补上新出现的指令文件。

预设必须自己挂这一行：agent preset 的 `plugins` 列表就是该 agent 的完整组成，profile 级
`dsh-base` 里的同名行不会继承过来，缺了它 agent 就看不到项目里的 `AGENTS.md`。这条指令
走的是 user 消息，不是系统提示词 section，所以 persona 行的 `complete: true` 不影响它。

`base-prompt.md` 的 Session context 段里另有一份手写的全局偏好快照，它不随文件更新。当
`~/.dsh/AGENTS.md` 存在时，同一份偏好会同时以模板快照和实时文件两种形式出现，两处要一起改。

## 自动压缩的时机与开关

压缩组里的 `compaction-basic` 行显式声明了两个值：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.6
    auto: true
```

上下文压力越过路由模型窗口的 60% 时，下一次请求派生前自动摘要最旧的历史；`auto` 是
这个功能的开关，改成 `false` 后自动压缩与溢出恢复都不再注册，手动 `/compact` 仍可用。
实际触发点取 `floor(min(W × 0.6, W − O − 65536))`：`W` 是模型窗口，`O` 是请求输出
预留，65536 是默认 `headroomTokens`。窗口不够大时触发会早于 60%，这个余量是留给压缩
摘要调用本身的。近期历史仍按默认 `retainRatio: 0.16` 逐字保留，它必须低于阈值比例。

配置写在 `cordis.patch.yml` 里，但该文件由 `scripts/build-patch.mjs` 生成：改时机或
开关要改脚本里的 YAML 模板并重新生成。profile 是以链接方式安装的，dsh 启动时重新
读取 bundle 的 patch 文件，所以重启后新建的会话按新值触发。

这件事也写进了基础提示词，就放在 `base-prompt.md` 的 Context management 段落里，随
模板一起版本化；`scripts/verify.mjs` 会检查渲染后的提示词里出现配置的百分比。

## 修改基础提示词

模板是生成出来的，不要直接改 `cordis.patch.yml` 里的 prefix 块。源模板是仓库根目录的
`base-prompt.md`，改完重新生成：

```
node scripts/build-patch.mjs
```

也可以把别的文件路径作为参数传给脚本。脚本按固定映射替换占位符（映射表在
`scripts/build-patch.mjs` 的 `REPLACEMENTS`），任何一条匹配不上就报错退出，避免静默
漏替换。这份模板原本复制自 `~/Documents/System prompt.md`；迁移之后以仓库内版本为准，
外部那份不再参与生成。profile 是链接安装，dsh 启动时重新读取 patch，所以改完重启即可；
新会话用上新提示词，已经开着的会话保留它启动时的插件版本。

只想调整 git 事实的细节（例如列出几条最近提交），可以给 `prompt-facts` 行加配置：

```
          - id: prompt-facts
            name: '@zilorn/dsh-efficient-mode'
            config:
              commitCount: 5
```

## 验证

离线自检（不需要运行中的 Harness）：

```
node scripts/verify.mjs
```

它会用桩上下文执行 `apply()`、从 `cordis.patch.yml` 抽出模板、核对模板引用与注册变量
是否一一对应、检查必填 `config` 是否都在、确认压缩行仍是 60% 阈值且 `auto` 仍是布尔
开关、确认工作区指令行仍挂着 `maxBytes: 65536`、逐句确认模板自带的工具规则仍在渲染结果里、
确认渲染后的提示词写明了压缩触发点、回放 `agent/inbox/claimed` 监听器确认语言提示只在中文
人类输入后出现且不被其它来源覆盖、确认无新输入时能回退读会话日志、渲染一遍并复查同一会话
两次组装结果一致，最后打印渲染后的完整提示词。任何一项不通过就以非零码退出。

安装后另需确认两点：安装结果是 `application: applied`；以及预设名册里出现 `efficient`
卡片且不显示「加载失败」。名册卡片由 Host 的预设 list 提供，可以用 agent 的
`cordis_inspect_query` 查 `Config.listConfigs`（过滤 `@deepseek-ai/dsh-agent-preset`）确认
`preset-efficient` 行存在。卡片里的诊断文字和会话内实际渲染出来的提示词，只能在浏览器和
选中该预设的新会话里确认。

## 已知限制

- **预设行的 `config` 不能凭感觉删。** 有些字段是必填且没有默认值的，漏掉一个就会让**整个预设**
  加载失败，名册上的卡片直接显示「加载失败」，任何会话都用不了这个预设。已知必填：
  `dsh-tool-fs-search` 的 `sampleOverCapGlobResults`、`dsh-persona` 的 `prefix`、
  `dsh-agent-instructions` 的 `maxBytes`、`dsh-plan-mode` 的 `section`。前三项由
  `scripts/verify.mjs` 校验；新增或改动工具行时，最好照抄随 dsh 发布的 `standard` 预设里
  同一行的 `config`。
- **同步探测**：git 调用是同步的，整次探测最长占用 3 秒（仅每会话首次组装时）。git 缺失、
  目录不是仓库、或超时都会降级为 `(not a git repository)` 一类占位文本，不会让提示词失败。
- **每会话一份快照**：会话中途新建的提交不会反映到提示词里，这是模板文案的既定语义。
  想强制刷新，开新会话即可。
- **语言提示逐轮变化**：判定只看 agent 最近一条人类输入，汉字占比 ≥25% 视为中文，出现
  假名（日文）则排除；提示行变化会让系统提示词在会话中途更新，dsh 以新增或替换 system
  消息的方式投影。用户在会话中途切换语言时，这就是预期行为；极短的英文回复（如 `ok`）
  会把提示切回默认，模型仍会从上下文判断该用什么语言。
- **`complete: true` 与工具指引**：`complete: true` 生效时，其它插件贡献的 section 会被折叠成
  persona 一段，所以工具使用规则由模板自带一份；当前桌面构建里工具插件注册的指引 section
  仍会追加在模板之后，同一段规则可能重复一次。工具本身始终可用，其参数说明始终通过工具
  schema 传给模型。
- **未声明 Config schema**：profile 安装的 bundle 无法从 dsh 安装目录解析 `schemastery`，
  所以这个包不 import 任何 harness 包，行配置以未校验的普通对象读取（只认 `commitCount`）。
- **`files` 字段对目录直装不生效**：dsh 直装本地目录时是以链接方式安装，改动源码后需要重新
  安装并重启才能加载新的 JS 模块版本。

## 环境

- dsh 0.2.0-rc.2（Desktop，`desktop` profile）
- Node.js ≥ 18（仅用到内置模块 `node:child_process`、`node:os`）
- `git` 在 PATH 中（缺失时退化为占位文本）
