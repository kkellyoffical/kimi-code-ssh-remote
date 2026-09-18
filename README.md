# kimi-code-ssh-remote

[Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork,以 **SSH 远程连接** 为主角:把远程机器保存为命名连接,一条命令建立 SSH 隧道,然后在本地浏览器里直接使用远端机器上的 Kimi Code 工作台——会话、文件和命令执行都留在远端。

> **English summary**: A fork of [Kimi Code](https://github.com/MoonshotAI/kimi-code) centered on SSH remote connections. Save a remote host with `kimi ssh add`, open a tunnel with `kimi ssh connect`, and drive the remote machine's Kimi Code web UI from your local browser — the first connect installs the CLI on the remote and starts its server automatically. This README covers the SSH feature, how to build the repo from source, how to enable the feature, and how to bind the built CLI as your `kimi` command. The original upstream README is preserved as [README_kimi.md](README_kimi.md) (English) and [README.zh-CN.md](README.zh-CN.md) (中文).

- 上游仓库: <https://github.com/MoonshotAI/kimi-code>
- 上游原版 README: [README_kimi.md](README_kimi.md)(英文)、[README.zh-CN.md](README.zh-CN.md)(中文)

## 这个 fork 与上游的关系

本仓库基于上游 `main`,在此基础上提供完整的 SSH 远程连接能力;其余功能与上游保持一致,并持续合并上游更新(同步方式见文末)。

SSH 能力的实现位置(便于核对与跟进上游变化):

- `apps/kimi-code/src/cli/sub/ssh/` — `kimi ssh` 命令树(add / list / remove / passwd / test / connect / host-key)
- `packages/ssh-remote/` — 连接注册表、SSH 隧道、远端安装与启动(bootstrap)
- `packages/kap-server/src/routes/sshConnections.ts` — SSH 连接的 REST API(`/api/v1/ssh/connections`)
- `packages/kap-server/src/routes/sshProxy.ts` — 把浏览器请求经隧道转发到远端的代理(`/ssh/<name>/*`)
- `packages/kap-server/src/routes/sshPage.ts` — 服务器内置的 `/ssh` 管理页
- `packages/kap-server/src/routes/webAssets.ts` — 向主 UI 注入右下角 SSH 入口

## SSH 功能全景

### 命令树

```sh
kimi ssh add prod ubuntu@example.com   # 保存连接(随后自动探测并报告认证状态)
kimi ssh list                          # 已保存的连接、认证方式及实时状态
kimi ssh test prod                     # 探测连通性、远端平台与 kimi 安装状态
kimi ssh connect prod                  # 建立隧道并打印/打开远端 web UI
kimi ssh passwd prod                   # 通过隐藏输入保存密码(--clear 清除)
kimi ssh host-key prod                 # 显示远端当前主机密钥指纹(--forget 删除已存储密钥)
kimi ssh remove prod                   # 删除连接(已连接则先断开)
```

常用选项:

| 命令 | 选项 | 说明 |
| --- | --- | --- |
| `add` | `--user <user>` | 登录用户,覆盖 `[user@]host` 中的 user 部分 |
| `add` | `--port <port>` | 远端 SSH 端口,默认 `22` |
| `add` | `--identity-file <path>` | 指定私钥文件认证 |
| `add` | `--password` / `--save-password` | 隐藏输入密码用于添加后的自动探测 / 并保存该密码 |
| `test` / `connect` | `--password` | 连接前先隐藏输入密码 |
| `connect` | `--direct` | 即使有本地服务在运行,也由当前终端持有隧道 |
| `connect` | `--no-open` | 不自动打开浏览器 |
| `passwd` | `--clear` | 清除已保存的密码 |
| `host-key` | `--forget` | 删除已存储的主机密钥,下次连接重新信任 |

`add` 不带 `target` 时在交互式终端逐项提示输入 host、user、port、identity 文件;连接名只允许字母、数字、点、下划线和短横。

### 三种认证方式

每次连接都先尝试公钥认证——ssh-agent 中已加载的密钥(`ssh-add`)、默认密钥文件、保存连接时指定的 `--identity-file`,以及 ssh config 中的配置。公钥失败且远端要求密码时:交互式终端用隐藏输入提示输入密码(密码一律不作为命令行参数传入,不会留在 shell 历史或进程列表中)并重试一次;非交互环境直接报错并给出处理指引。

1. **免密(agent / 默认密钥)**:把密钥加载进 ssh-agent,或 `add` 时加 `--identity-file`,无需其他配置。
2. **密钥文件**:`kimi ssh add prod example.com --identity-file ~/.ssh/id_ed25519`。
3. **密码(可选记住)**:`kimi ssh passwd prod` 保存后 `connect`/`test` 自动使用;或 `connect prod --password` 当次输入——输入密码后会询问是否记住,验证通过才会保存,失败不落盘。

> 已保存的密码以**明文**存放在 `~/.kimi-code/ssh/secrets.json`(文件权限 `0600`)。保存密码永远是显式选择,不会自动发生;多人共用的机器上请优先使用密钥认证。

### 主机密钥策略

`kimi ssh` 与系统 `ssh` 共用同一个 `known_hosts` 文件。首次连接某台主机时自动信任并记录其密钥(`StrictHostKeyChecking=accept-new`);此后每次连接都要求远端提供同一把密钥。

当远端密钥发生变化时,`test` / `connect` 会拒绝继续,并打印**已存储指纹与远端当前指纹的对比**。密钥变更可能是中间人攻击,也可能是重装系统、轮换密钥等正当变化——先比对确认,再:

- `kimi ssh host-key prod` 查看远端当前提供的指纹;
- `kimi ssh host-key prod --forget` 删除旧密钥,下次连接按 accept-new 重新信任(交互式终端会在打印对比后直接询问是否删除旧密钥并重试;等效的手动命令是 `ssh-keygen -R <host>`)。

### 两种连接模式

`kimi ssh connect prod` 的行为取决于本地服务(`kimi web`)是否在运行:

- **代理模式(默认,有本地服务)**:由本地服务持有隧道,命令打印两个 URL 后退出——远端 web UI 地址和 `/ssh` 管理页地址。隧道随服务存续,终端可以关掉。
- **直连模式(无本地服务,或显式 `--direct`)**:隧道由当前终端持有,打印的 URL 指向隧道端口上远端自己的 web UI,按 `Ctrl+C` 断开。

首次对一台新远端执行 `connect` 时,会自动探测远端平台(支持 Linux / macOS,x64 与 arm64)、把 Kimi Code CLI 上传到远端并启动其 `kimi web` 服务(绑定远端 `127.0.0.1:58627`);之后的连接直接复用这套环境。

### Web 入口

- **主 UI 右下角 SSH 按钮**:`kimi web` 启动后,服务器会向主 UI 注入一个固定在右下角的「SSH」入口,点击即进入 `/ssh` 管理页(自动携带 `#token=`)。
- **`/ssh` 管理页**:浏览器里的 SSH 控制台——添加连接(可选 agent/默认密钥、identity 文件、密码+记住密码三种认证)、测试、连接、断开、输入/忘记密码、删除,并显示各连接的实时状态(已连接 / 连接中 / 错误 / 未连接)。地址为 `http://127.0.0.1:58627/ssh#token=<启动横幅中的 token>`。
- **Open 跳转远端工作台**:连接建立后,点列表中的 Open(或 CLI `connect` 自动打开的地址)会打开 `http://127.0.0.1:58627/?kimi_origin=http://127.0.0.1:58627/ssh/prod#token=...`——加载的是本地 web UI,但所有 API 请求都经 `?kimi_origin=` 指向隧道端点,由 SSH 隧道转发到远端。

### 安全模型

- 浏览器只持有**本地服务**的 token(通过 URL `#token=` 片段传入,片段本身不会随 HTTP 请求发出,由页面脚本读取后作为本地 API 的 Bearer 凭证)。
- 请求经 `/ssh/<name>` 代理转发时,本地服务会**剥离浏览器发来的 `Authorization` 等敏感请求头,在进程内注入远端服务的 token**——远端 token 从不进入浏览器,也不出现在任何 URL 中。
- 远端服务只绑定远端机器的回环地址 `127.0.0.1`,仅能通过 SSH 隧道到达;会话数据、文件与 shell 执行全部留在远端机器上。
- 本地服务默认也只绑定 `127.0.0.1`;端口被占用时自动尝试下一个(58628、58629……),以启动横幅实际打印的地址为准。

### 数据文件

- 连接注册表:`~/.kimi-code/ssh/connections.json`
- 已保存的密码:`~/.kimi-code/ssh/secrets.json`(明文,`0600`)
- 主机密钥:与系统 ssh 共用的 `~/.ssh/known_hosts`
- `KIMI_CODE_HOME` 环境变量可把整个数据目录改到别处(此时上述路径相应变为 `$KIMI_CODE_HOME/ssh/...`)。

没有运行中的本地服务时,`kimi ssh` 直接读写本地注册表(`list` 会提示只有本地注册表、无实时状态);有服务在运行时,CLI 一律通过服务的 REST API 操作,终端与 web UI 共享同一批隧道。

## 从源码构建

### 环境要求

- **Node.js >= 24.15.0**(`.nvmrc` 为 `24.15.0`;仓库 `.npmrc` 设置了 `engine-strict=true`,版本不满足时 `pnpm install` 会直接失败)
- **pnpm 10.33.0**(与根 `package.json` 的 `packageManager` 一致;可用 `corepack` 或 `npm i -g pnpm@10.33.0` 准备)

### 构建步骤

```sh
git clone https://github.com/kkellyoffical/kimi-code-ssh-remote.git
cd kimi-code-ssh-remote

pnpm install        # 安装全部 workspace 依赖
pnpm run build      # 构建所有 packages 与 CLI(等价于 make build)
```

构建产物是 `apps/kimi-code/dist/main.mjs`(单个 ESM 文件,自带 `#!/usr/bin/env node` 与可执行权限)。web UI 的预构建产物 `apps/kimi-code/dist-web` 已随仓库提交,构建时的 `check-web-assets` 会校验其在位,因此**不需要单独构建前端**。

验证构建结果:

```sh
./apps/kimi-code/dist/main.mjs --version    # 打印版本号(当前为 2.0.0)
./apps/kimi-code/dist/main.mjs ssh --help   # 确认 ssh 命令树可用
```

以上命令已在本仓库实际执行验证:Node v24.19.0 + pnpm 10.33.0 下 `pnpm install` 与 `pnpm run build` 成功,产物 `--version`、`ssh --help`、`ssh list` 均正常工作;下文「方式 C」的 `pnpm link --global` 绑定链路也同样实测通过。

其他常用入口:

- 开发模式(免构建、从源码直接跑):`pnpm dev:cli`
- 单文件可执行程序(官方安装包同源的 Node SEA 打包流程,macOS 上涉及 codesign,一般不需要):`pnpm --filter @moonshot-ai/kimi-code run build:native:sea`,脚本见 `apps/kimi-code/scripts/native/`

## 启用 SSH 功能

> **最方便的路径**:`kimi web` 启动本地服务 → 浏览器打开主 web UI → 点主 UI **右下角的「SSH」按钮** → 进入 `/ssh` 控制台「添加连接」,点「连接」、状态变为「已连接」后点 **Open**,即可开始使用远端机器上的 Kimi Code。
>
> **token 的填法与安全警示**:本地服务器的 token 只填在**本地窗口 / 本地页面**——浏览器地址栏的 `#token=` 片段(`kimi web` 启动横幅、`kimi ssh connect` 打印并自动打开的,正是这种带 `#token=` 的本地 URL),或 `/ssh` 控制台顶部的「访问令牌」输入框。该片段不会随 HTTP 请求发出(也不会进入服务日志或代理日志),由页面脚本读取后作为本地 API 的 Bearer 凭证;持有它等于能控制本机上的会话、文件系统和 shell,**千万不要把 token 填到任何其他地方**——远端机器、聊天窗口、任何第三方页面或表单。远端服务的 token 你永远不需要手填:请求经 `/ssh/<name>` 代理转发时,由本地服务在进程内自动注入,远端 token 不进入浏览器,也不出现在任何 URL 中。

### 链路一:纯 CLI

```sh
kimi ssh add prod ubuntu@example.com   # 保存并自动探测;需要密码时按提示操作
kimi ssh connect prod                  # 建立隧道,打印并自动打开远端 web UI
```

`connect` 打印的地址在浏览器打开后就是远端机器上的 Kimi Code 工作台。首次连接会自动在远端安装 CLI 并启动服务,之后秒连。

### 链路二:Web 控制台

```sh
kimi web    # 启动本地服务并打开 web UI;横幅会打印带 #token= 的地址
```

1. 打开启动横幅中的地址(默认 `http://127.0.0.1:58627/#token=...`);
2. 点击主 UI **右下角的「SSH」按钮**(或直接访问 `http://127.0.0.1:58627/ssh#token=<token>`);
3. 在 `/ssh` 页「添加连接」:填名称、主机(可选 user、端口),选认证方式(agent/默认密钥、identity 文件,或密码+记住密码);
4. 列表中点「连接」,状态变为「已连接」后点 **Open**,即进入远端工作台。

两条链路共享同一批连接与隧道:CLI 添加的连接会出现在 `/ssh` 页,页面上建立的隧道对 CLI 同样可见。

> 远端机器上运行的是独立的 Kimi Code 服务:模型登录态、配置与会话数据都保存在远端(`~/.kimi-code`),首次在远端工作台中按提示完成登录即可。

## 把构建产物绑定为 `kimi` 命令

构建完成后,`kimi` 指向的就是 `apps/kimi-code/dist/main.mjs`。以下几种方式按改动从小到大排列,任选其一(把 `<repo>` 换成仓库的绝对路径,如 `/Users/you/kimi-code-ssh-remote`):

**方式 A:shell 别名(最简单,零安装)**

在 `~/.zshrc`(或 `~/.bashrc`)中加入:

```sh
alias kimi='<repo>/apps/kimi-code/dist/main.mjs'
```

**方式 B:符号链接到 PATH 目录**

```sh
mkdir -p ~/.local/bin
ln -sf <repo>/apps/kimi-code/dist/main.mjs ~/.local/bin/kimi
# 确保 ~/.local/bin 在 PATH 中
```

产物自带 shebang 与可执行权限,链接后可直接运行。

**方式 C:pnpm 全局链接**

```sh
cd <repo>/apps/kimi-code
pnpm link --global
```

链接进 pnpm 的全局 bin 目录(首次使用先 `pnpm setup`,并确认该目录在 PATH 中,macOS 上通常是 `~/Library/pnpm`)。

**方式 D:npm 全局链接**

```sh
cd <repo>/apps/kimi-code
npm link
```

链接进 `npm prefix -g` 的 `bin` 目录。

### 与官方版共存 / 覆盖注意事项

- 官方安装脚本把单文件二进制放在 `~/.kimi-code/bin/kimi`;官方 npm 包(`npm i -g @moonshot-ai/kimi-code`)则放在 npm 全局前缀的 `bin` 下。`which -a kimi` 可以列出 PATH 上的所有命中,**排在前面的生效**。
- 想两者共存,给 fork 起个别名而不是占用 `kimi`:`alias kimi-ssh='<repo>/apps/kimi-code/dist/main.mjs'`。
- 注意:无论官方版还是本 fork,默认都读写**同一个** `~/.kimi-code` 数据目录(登录态、会话、`ssh/connections.json`、本地服务 token 都共享)。想让两套完全隔离,为其中一个设置 `KIMI_CODE_HOME` 环境变量。
- 用 `kimi --version` 确认当前解析到的是哪个构建(本仓库当前构建为 `2.0.0`)。
- 重新构建(`git pull` 后 `pnpm install && pnpm run build`)无需重新绑定——别名、符号链接和全局链接都指向同一产物路径。

## 与上游保持同步

```sh
git remote add upstream https://github.com/MoonshotAI/kimi-code.git   # 只需一次
git fetch upstream
git merge upstream/main        # 或 git rebase upstream/main
```

合并后重新执行 `pnpm install && pnpm run build` 即可。SSH 相关实现集中在上一节列出的目录,解决冲突时重点关注这些路径与上游的交叉改动。

## 许可证

与上游一致,[MIT](LICENSE)。
