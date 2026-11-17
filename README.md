# dsh-alert

**DSH 授权 / 提问提醒插件 —— 当 DSH 停下来等你时，用 Windows 系统通知 + 提示音把你叫回来。**

> DSH 需要你批准操作、回答提问或审批计划时会静默等待。窗口不在前台时，你很可能完全不知道。
> 这个插件在那一刻弹出系统通知并播放提示音，避免任务卡在后台无人处理。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#兼容性)

---

## 特性

| 会话事件 | 触发提醒 |
|---|---|
| `approval/asked` | DSH 需要你**授权**一个操作 |
| `tool/call` = `ask_user_question` | DSH 在等你**回答问题** |
| `tool/call` = `exit_plan_mode` | **计划审批** |

- **双通道**：优先发 Windows 原生 Toast（走通知中心）；发送失败时自动退回右下角自绘卡片，保证不漏。
- **提示音可换**：默认用系统 wav，支持自定义路径或外部播放器。
- **可精细关闭**：按触发类型、按通道（只响 / 只弹 / 都弹）单独开关。
- **零依赖**：只用 Node 内置模块，不额外拉包。

## 安装

> **仅支持 Windows**，需要 DSH 桌面端（内置 Electron）。插件运行在 DSH 宿主进程里，因此能正常发送系统通知。

### 第 1 步：注册系统通知身份（只需一次）

Windows 10 的 WinRT 通知要求未打包程序先有 AUMID，否则报 `0x80073D54 no package identity`。
把下面整段粘进 **Windows PowerShell 5.1**（不是 pwsh 7）执行：

```powershell
$id  = 'Dsh.Alert'
$dir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $dir 'DSH Alert.lnk'

# 1) 开始菜单占位快捷方式（通知身份需要它指到一个真实入口）
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$sc.Arguments  = '-NoProfile -WindowStyle Hidden -Command "$null"'
$sc.Save()

# 2) 注册 AUMID
New-Item -Path "HKCU:\Software\Classes\AppUserModelId\$id" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\AppUserModelId\$id" -Name DisplayName -Value 'DSH 提醒'
Set-ItemProperty -Path "HKCU:\Software\Classes\AppUserModelId\$id" -Name IconUri `
  -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
```

### 第 2 步：装进 profile

```powershell
# 方式 A：dsh 命令（link 安装，保留源码目录可编辑）
dsh plugin add --profile desktop link:<本仓库绝对路径>

# 方式 B：手工
# 把整个仓库目录复制到 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-alert
# 然后在该 profile 的 cordis.patch.yml 末尾追加：
#   - insert:
#       - id: dsh-alert
#         name: dsh-alert
```

### 第 3 步：重启 DSH

插件在启动时合成，重启后生效。

## 配置

可选文件：`$DSH_HOME/.dsh-alert.json`（默认 `%USERPROFILE%\.dsh\.dsh-alert.json`）。
不写则全部使用默认值。

```json
{
  "enabled": true,
  "mode": "toast",
  "toast": true,
  "fallbackPopup": true,
  "sound": true,
  "durationMs": 6000,
  "triggers": { "approval": true, "question": true },
  "sounds": {
    "approval": "C:\\Windows\\Media\\Windows Exclamation.wav",
    "question": "C:\\Windows\\Media\\Windows Notify.wav"
  },
  "playerCommand": "",
  "minIntervalMs": 3000
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `mode` | `toast`（系统通知，失败自动退回卡片）/ `popup`（只弹右下角卡片）/ `sound`（只响） |
| `toast` | 是否尝试系统通知 |
| `fallbackPopup` | Toast 失败时是否弹卡片 |
| `sound` | 是否播放提示音 |
| `durationMs` | 卡片停留时长（毫秒） |
| `triggers.approval` | 授权请求是否提醒 |
| `triggers.question` | 提问 / 计划审批是否提醒 |
| `sounds.approval` / `sounds.question` | 提示音 wav 路径 |
| `playerCommand` | 改用外部播放器，`%file%` 为占位符，如 `ffplay -nodisp -autoexit "%file%"` |
| `minIntervalMs` | 两次提醒的最小间隔，防轰炸（默认 3000） |

## 工作原理

```
DSH 会话事件
   ├─ approval/asked            ─┐
   ├─ tool/call(ask_user_question)├─→ 节流 → 播放提示音 → WinRT Toast
   └─ tool/call(exit_plan_mode)  ─┘              └─ 失败 → 右下角卡片
```

- 通知由宿主进程（DSH 主进程）里的 `powershell.exe`（5.1）调用 WinRT 发送；
- 沙箱内进程发不了系统通知（受限令牌），插件因此运行在宿主侧；
- 所有失败路径都退到自绘卡片，不会静默失败。

## 兼容性

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| DSH | 桌面端（Electron，宿主进程） |
| PowerShell | 系统自带 5.1（`pwsh` 7 缺少 WinRT 引用，插件已硬编码 5.1 路径） |
| Node | ≥ 20（仅开发/调试需要） |

## 常见问题

**没看到通知 / 没声音？**
1. 确认 `设置 → 系统 → 通知` 没有被关闭，且未开启「专注助手」；
2. 确认第 1 步 AUMID 已注册（注册表 `HKCU\Software\Classes\AppUserModelId\Dsh.Alert` 存在）；
3. 把 `mode` 临时改成 `popup`，排除 Toast 通道问题；
4. 检查是否命中 `minIntervalMs` 节流。

**提示音想换成自己的？**
把 wav 路径填进 `sounds.approval` / `sounds.question`，或改用 `playerCommand` 调外部播放器。

**会重复弹吗？**
同一触发在 `minIntervalMs` 内只弹一次。

## English

`dsh-alert` is a DSH plugin that pops a native Windows toast and plays a sound whenever the
harness pauses for your approval or an answer. It covers `approval/asked`, `ask_user_question`,
and `exit_plan_mode`. If the toast channel fails, it falls back to a custom corner card, so
you never miss a prompt. Windows-only, zero runtime dependencies, MIT licensed.

## License

[MIT](LICENSE) © 2026 Chen HuaJing (Dvva)
