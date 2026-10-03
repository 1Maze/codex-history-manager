# Codex History Manager

本地 Codex 聊天记录管理工具：阅读对话、定位原始 JSONL 数据、编辑事件，并同步重建对应的 SQLite 历史索引。

**数据保留在自己的电脑上，服务只监听 `127.0.0.1`。本项目不是公共聊天服务，不会自动上传聊天记录。**

## 功能

- 对话页显示用户发言和助手文字，隐藏工具、推理和环境上下文，合并重复消息，支持 Markdown 和长消息展开。
- “我的发言”列表、右侧刻度和预览支持跳转，文件代码图标定位 JSONL 原始行。
- 分支会话可读取继承窗口，定位继承消息时打开实际保存它的父会话。
- 项目默认全部收起，可全部展开/收起、拖动排序；先显示最近 5 条对话，再逐批加载。
- 项目右键支持展开、折叠、忽略、项目内搜索；搜索范围为对话标题和 ID。
- “已忽略项目”独立页面支持查找、单独恢复和全部恢复，不删除聊天。
- 原始数据支持单条/完整文件编辑、类型筛选、搜索、批量删除、删除后续记录、撤销和重做。
- 支持删除当前记录之前或之后的所有记录，保留当前记录；操作按原文件顺序进行，不受筛选影响。
- SQLite 页检查会话元数据、轮次、消息和投影游标，并定位对应原始事件。
- 同步保存提供文件锁、外部修改检测、原生索引重建、备份、异常回滚和恢复日志。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | macOS / Linux；Windows 文件锁尚未适配 |
| Python | 3.10+ |
| Python 第三方依赖 | 无，运行时仅使用标准库 |
| Codex CLI | 同步重建索引需要本机可用的 `codex` 命令 |
| 数据库 | 数据目录下的 `state_5.sqlite`、`thread_history_1.sqlite` |
| 浏览器 | 现代浏览器；普通文件直接覆盖能力取决于浏览器文件访问 API |

数据库结构和原生解析器必须兼容。当前版本不会自动发现其他数据库版本或自定义 `sqlite_home` 目录；校验失败时拒绝写入。

## 快速开始

```sh
git clone git@github.com:1Maze/codex-history-manager.git
cd codex-history-manager
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py --port 5189
```

打开 `http://127.0.0.1:5189`。

`requirements.txt` 目前仅有说明注释，没有需要下载的运行时包。也可以直接启动：

```sh
python3 server.py
```

数据目录按 `--home` 参数、`CODEX_HOME` 环境变量、当前用户 `~/.codex` 的顺序确定。

```sh
python3 server.py --home /absolute/path/to/codex-home --port 5190
```

确认 CLI 可用：

```sh
command -v codex
codex --version
```

CLI 不可用时不能完成原生索引重建。查看数据不需要模型 API 调用，本项目不需要 OpenAI API key。

## 使用方式

选择项目和会话进入对话页。“我的发言”和右侧刻度提供跳转；文件代码图标选中原始记录。长消息可展开，不改变文件。

每条消息的铅笔图标可直接编辑发言或助手文字，**保存修改** 仍经过确认、备份和 SQLite 同步流程，不必跳转到原始数据。取消编辑不改变草稿，编辑时也可用保存快捷键。

**原始数据** 页提供编辑；**SQLite** 页检查：

```text
threads
thread_turns
thread_items
thread_history_projection_state
thread_realtime_items
```

SQLite 单元格只读。请编辑 JSONL 后使用 **同步保存** 重建派生历史数据。`state_5.sqlite` 会话元数据不直接修改，`session_meta` 受保护；本工具不是通用 SQL 编辑器。

项目刷新后默认全部收起。**显示更多** 每次加载 5 条，**收起更多** 回到前 5 条。排序和忽略列表存于浏览器本地，不改变 Codex 的项目顺序。侧栏底部可进入 **已忽略项目** 页面；关闭搜索范围标记可退出项目内搜索。

**关联消息** 默认联动已确认的消息副本。同一轮次中关联明确的 `task_complete.last_agent_message` 摘要也会更新；不会按文本相同批量修改无关消息或工具输出。副本文本或摘要存在冲突时会拒绝修改，需要在原始数据中确认。

对话内编辑会保留附件与输入上下文。原始数据保存的自动联动仍主要针对同 ID、单段文本记录，不能保证所有多段文本或不同 ID 的副本都自动关联。需要精确按行修改时取消该选项。编辑继承消息会提示打开父会话，修改父会话可能影响其他分支，不会自动修复分支的继承边界。

结构编辑后重新连续编号 `ordinal`；分支从继承边界开始编号，未变化的行尽量保留格式。使用 **打开文件** 打开的普通 JSONL 不关联 SQLite。

**删除之前所有记录** 会保留当前记录及后续数据。关联 Codex 会话时，首行 `session_meta` 不会删除。删除必要的任务上下文可能导致原生同步校验失败，此时不会写回；可撤销或选择更合适的边界。

## 保存与恢复

### 手动备份

右上角的备份图标可随时备份当前会话的磁盘数据，包括 JSONL、关联 SQLite 数据库与继承记录。未保存的网页编辑不会进入备份。

**备份管理** 可查看手动备份及保存前的自动备份，复制路径、按当前会话筛选和恢复。恢复只替换所选会话的 JSONL，并原生重建索引，不恢复整个数据库、不回滚其他聊天；恢复前会再次备份当前状态。备份损坏、版本冲突、写入锁或继承窗口变化时拒绝恢复。

### 对话截选

选择会话后进入 **对话截选** 页，选择最近完整轮次数，生成预览并确认所选对话或续聊文本。预览列出轮次、记录数和数据大小，未完成轮次不自动选入。导出文本可用于手工开启新的空白聊天。

**生成独立副本** 默认使用 **原始对话截选**：保留最近完整轮次的用户与助手消息、推理记录、工具调用及返回值，保持原有角色、顺序和上下文配置。预览按角色展示消息，工具可展开查看；预览中的长文本会节选，但副本的所选消息和工具输出不截断。默认保留最近 1 个完整轮次。

副本先在隔离的本机原生 API 中解析，核对消息/工具项目与索引，再注册到当前数据目录。原会话会自动备份且不裁剪，新副本不带 `history_base` 或分支继承关系；旧的 `compacted` 模型压缩检查点不复制，避免重新引入早期历史。工具只复制记录，不会重新执行。工具调用缺少对应返回值时拒绝创建。

**单条续聊文本** 是可选模式，将可编辑的整理文本作为一条用户消息，不保留工具记录，也不伪造助手回复。**导出文本** 只下载 Markdown，不能保留真实对话角色，亦不会自动注册 Codex 会话。

保留大量工具输出仍可能超过模型上下文限制，请参考预览中的原始大小并减少轮次。创建与原生解析成功不等于已验证模型续聊。网页自动打开副本，Codex 侧可能需要刷新会话列表。

续聊文本不是 AI 自动总结，模板中的目标、约束和验证状态需要确认；每条摘录超过 3000 字符时会明确标记节选。续聊文本限制为 64 KiB，不是精确 token 统计。没有模型调用验证，因此创建成功不保证上下文错误一定消失。

独立副本注册涉及两个 SQLite 数据库及文件，不是一个跨文件的原子事务。创建日志用于检测崩溃边界；发现未完成安装会阻止继续操作相应副本，需要人工检查日志。

**先停止目标聊天并关闭它，再同步保存。** Codex 可能保留内存中的旧历史，外部修改后应重新打开聊天。

保存流程：

1. 获取会话写入锁，检查文件、缓存、元数据和继承窗口的外部变化。
2. 校验 UTF-8、JSONL、会话身份和不可变元数据。
3. 将副本放入临时 `CODEX_HOME`，用 Codex CLI 的分支准备流程生成原生投影；临时分支会删除，不启动模型任务。
4. 验证字节偏移和事件编号，备份文件与数据库。
5. 在 SQLite 事务中替换当前会话的历史行，原子替换 JSONL，再提交事务。

JSONL 和 SQLite 无法组成同一个原子事务。普通异常会恢复文件并回滚数据库；崩溃或断电发生在写入边界时需要检查恢复日志。重启后，待恢复会话会被禁止再次写入。

**不要在 Codex 正在运行时恢复整个旧数据库。** 其他聊天可能已有新变化；恢复时只处理受影响会话的文件和历史行。

备份位置：

```text
<CODEX_HOME>/backups/chat-sync-workbench/<timestamp>-<id>/
├── rollout.before.jsonl
├── thread_history.before.sqlite
├── state.before.sqlite
└── journal.json
```

默认在 `~/.codex/backups/chat-sync-workbench/`。文件栏的备份图标可复制最近一次备份路径。

每次保存会复制数据库用于隔离校验和备份，需保留足够磁盘空间。当前会话及继承记录合计上限为 180 MiB。

## 安全与限制

- 只绑定回环地址，校验 Host、Origin 和 API token，不开放跨站 CORS。
- **不要通过反向代理、隧道或公网端口暴露本服务。**
- 仅允许读取已登记会话，并写入当前数据目录下的会话文件。
- 数据表允许列表、参数化 SQL；Markdown 原始 HTML 转义，远程图片不自动加载，链接协议受限制。
- 浏览器设置只属于本机当前浏览器，不代表跨设备同步。
- 尚未实现 Windows 支持、公共多用户服务、云端同步或自动适配未来数据库版本。

聊天和工具输出可能含路径、账号或密钥。仓库不应包含真实 JSONL、SQLite、HAR、备份、日志或聊天截图。

## 开发与测试

Python 测试需要本机兼容的 Codex 数据库和 CLI。只读取数据库结构和迁移信息，在临时目录生成虚构聊天，不复制实际聊天内容、不写回真实数据库。

```sh
python3 -m unittest -v test_store.py
python3 -m unittest -v test_recovery.py
node --check static/app.js
node test_transcript.cjs
```

浏览器测试额外需要 Node.js 20+ 和 Playwright：

```sh
npm install
npx playwright install chromium
```

另开终端运行本机服务，再执行：

```sh
node test_browser.cjs
node test_conversation.cjs
node test_sort.cjs
node test_sidebar.cjs
node test_project_menu.cjs
node test_inline_edit.cjs
node test_delete_before.cjs
node test_backup_recovery.cjs
```

默认使用 Playwright Chromium。`PLAYWRIGHT_BROWSER_CHANNEL=chrome` 可指定已安装的 Chrome，`PLAYWRIGHT_MODULE` 可指定现有模块路径。测试截图保存到 `qa/`，不提交到 Git。

## 文件结构

```text
server.py              HTTP 服务与访问控制
store.py               校验、原生重建、备份与同步
recovery.py            手动备份管理与独立对话截选/文本续聊副本
static/                网页、样式、对话解析与前端库
test_*.py / test_*.cjs  后端、解析和浏览器测试
requirements.txt       Python 运行依赖说明
package.json           可选浏览器测试依赖
```

前端已提供 Lucide 和 Marked，无需在运行时下载。第三方许可证保留在 `static/LUCIDE-LICENSE` 和 `static/MARKED-LICENSE`。
