// dsh-alert —— DSH 授权/提问提醒插件
// 作用：会话需要你「批准操作」或「回答问题」时，弹出 Windows 系统通知并播放提示音，
//       避免 DSH 在后台默默等待、而你完全不知道。
//
// 触发点（会话事件）：
//   approval/asked                  → 权限审批请求
//   tool/call（ask_user_question）   → 普通提问
//   tool/call（exit_plan_mode）      → 计划审批
//
// 通知通道：
//   ① Windows 原生 Toast（走 AUMID "Dsh.Alert"，需先运行 install-aumid.ps1 注册一次）
//   ② 若 Toast 失败（退出码非 0），自动退回右下角自绘卡片
//   两条通道都带声音。
//
// 配置：$DSH_HOME/.dsh-alert.json（可选）
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, '.dsh-alert.json')

// Windows PowerShell 5.1 的绝对路径（pwsh 7 缺 WinForms/WinRT 引用，必须用 5.1）
const WIN_PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const APP_ID = 'Dsh.Alert'

const DEFAULT_SOUNDS = {
  approval: 'C:\\Windows\\Media\\Windows Exclamation.wav',
  question: 'C:\\Windows\\Media\\Windows Notify.wav',
}

const DEFAULTS = {
  enabled: true,
  mode: 'toast',         // toast（系统通知，失败自动退回卡片）| popup（只弹卡片）| sound（只响）
  toast: true,           // 是否尝试系统通知
  fallbackPopup: true,   // 系统通知失败时是否弹右下角卡片
  sound: true,
  durationMs: 6000,      // 卡片停留时长
  triggers: { approval: true, question: true },
  sounds: {},
  playerCommand: '',
  minIntervalMs: 3000,
}

// ---------- 配置 ----------
let configCache = { mtimeMs: 0, value: null }

function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE)
    if (configCache.value && st.mtimeMs === configCache.mtimeMs) return configCache.value
    const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const merged = {
      ...DEFAULTS,
      ...user,
      triggers: { ...DEFAULTS.triggers, ...(user.triggers || {}) },
      sounds: { ...DEFAULT_SOUNDS, ...(user.sounds || {}) },
    }
    configCache = { mtimeMs: st.mtimeMs, value: merged }
    return merged
  } catch {
    return { ...DEFAULTS, triggers: { ...DEFAULTS.triggers }, sounds: { ...DEFAULT_SOUNDS } }
  }
}

// ---------- 工具 ----------
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ')
}

function runPowerShell(script, { onFail = null } = {}) {
  try {
    const exe = fs.existsSync(WIN_PS) ? WIN_PS : 'powershell.exe'
    const b64 = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    if (onFail) {
      // 1.8 秒内异常退出视为 Toast 通道不可用，触发回退
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        try { child.unref() } catch (err) {}
      }, 1800)
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) onFail()
      })
      child.on('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        onFail()
      })
    } else {
      child.unref()
    }
    return true
  } catch {
    return false
  }
}

function playWithExternalPlayer(command, file) {
  try {
    const parts = command.replace(/%file%/g, file).match(/(?:[^\s"]+|"[^"]*")+/g) || []
    const argv = parts.map((p) => p.replace(/^"|"$/g, ''))
    if (argv.length === 0) return false
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

// ---------- 通道 1：系统 Toast ----------
function buildToastScript(cfg, kind, title, body) {
  const file = (cfg.sounds && cfg.sounds[kind]) || DEFAULT_SOUNDS[kind]
  const playLine = cfg.sound
    ? `try { (New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync() } catch {}`
    : ''

  return [
    '$ErrorActionPreference = "Stop"',
    playLine,
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual><audio silent="true" /></toast>')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(APP_ID)}).Show($toast)`,
  ].filter(Boolean).join('\r\n')
}

// ---------- 通道 2：右下角卡片（回退） ----------
function buildPopupScript(cfg, kind, title, body) {
  const file = (cfg.sounds && cfg.sounds[kind]) || DEFAULT_SOUNDS[kind]
  const duration = Math.max(1000, Number(cfg.durationMs) || 6000)
  const accent = kind === 'approval' ? '255,186,60' : '78,161,255'
  const accentTitle = kind === 'approval' ? '255,200,80' : '130,190,255'
  const W = 420
  const H = 146
  const playLine = cfg.sound
    ? `try { (New-Object System.Media.SoundPlayer ${psQuote(file)}).Play() } catch {}`
    : ''

  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    playLine,
    `$W = ${W}; $H = ${H}`,
    '$f = New-Object System.Windows.Forms.Form',
    "$f.FormBorderStyle = 'None'",
    "$f.StartPosition = 'Manual'",
    '$f.ShowInTaskbar = $false',
    '$f.TopMost = $true',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(26,26,30)',
    '$f.Size = New-Object System.Drawing.Size($W, $H)',
    '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$f.Location = New-Object System.Drawing.Point(($area.Right - $W - 24), ($area.Bottom - $H - 24))',
    '$bar = New-Object System.Windows.Forms.Panel',
    `$bar.BackColor = [System.Drawing.Color]::FromArgb(${accent})`,
    '$bar.SetBounds(0, 0, 6, $H)',
    '$f.Controls.Add($bar)',
    '$l1 = New-Object System.Windows.Forms.Label',
    `$l1.Text = ${psQuote(title)}`,
    `$l1.ForeColor = [System.Drawing.Color]::FromArgb(${accentTitle})`,
    "$l1.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)",
    '$l1.SetBounds(22, 14, ($W - 44), 34)',
    '$f.Controls.Add($l1)',
    '$l2 = New-Object System.Windows.Forms.Label',
    `$l2.Text = ${psQuote(body)}`,
    '$l2.ForeColor = [System.Drawing.Color]::FromArgb(232,232,232)',
    "$l2.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)",
    '$l2.SetBounds(22, 54, ($W - 44), 80)',
    '$f.Controls.Add($l2)',
    '$t = New-Object System.Windows.Forms.Timer',
    `$t.Interval = ${duration}`,
    '$t.Add_Tick({ $t.Stop(); $f.Close() })',
    '$t.Start()',
    '[System.Windows.Forms.Application]::Run($f)',
  ].filter(Boolean).join('\r\n')
}

// ---------- 提醒 ----------
const lastAlertAt = new Map()

function alert(kind, sessionTitle, detail) {
  const cfg = loadConfig()
  if (!cfg.enabled) return
  if (cfg.triggers && cfg.triggers[kind] === false) return

  const now = Date.now()
  const last = lastAlertAt.get(kind) || 0
  if (now - last < Math.max(0, Number(cfg.minIntervalMs) || 0)) return
  lastAlertAt.set(kind, now)

  const isApproval = kind === 'approval'
  const title = isApproval ? 'DSH 需要你的授权' : 'DSH 在等你回答'
  const who = sessionTitle ? `「${sessionTitle}」` : ''
  const action = isApproval ? '有一个操作在等你批准' : '有一个问题在等你回答'
  const body = `${who}${action}${detail ? ` ${detail}` : ''}`

  if (cfg.playerCommand) {
    playWithExternalPlayer(cfg.playerCommand, (cfg.sounds && cfg.sounds[kind]) || DEFAULT_SOUNDS[kind])
  }

  if (cfg.mode === 'sound') return

  const showPopup = () => {
    if (!cfg.fallbackPopup && cfg.mode === 'toast') return
    // 声音已由 Toast 脚本播过，回退卡片不再重复响
    runPowerShell(buildPopupScript({ ...cfg, sound: false }, kind, title, body))
  }

  if (cfg.mode === 'popup' || cfg.toast === false) {
    showPopup()
    return
  }

  // 先试系统通知；失败则退回卡片
  runPowerShell(buildToastScript(cfg, kind, title, body), { onFail: showPopup })
}

// ---------- 插件本体 ----------
function pickTitle(session) {
  try {
    const t = session && (session.title || session.name || session.label)
    return t ? String(t).slice(0, 40) : ''
  } catch {
    return ''
  }
}

export default {
  name: 'dsh-alert',
  apply(ctx) {
    const titles = new Map()

    const off = ctx.on('session/event', (session, event) => {
      try {
        const type = String(event && event.type ? event.type : '')
        const data = (event && event.data) || {}
        const sid = session && session.id ? String(session.id) : 'default'

        if (type === 'session/title') {
          const t = String(data.title == null ? '' : data.title).trim()
          if (t) titles.set(sid, t.slice(0, 40))
          return
        }

        if (type === 'approval/asked') {
          const tool = data.toolName || data.tool || (data.request && data.request.toolName) || ''
          alert('approval', titles.get(sid) || pickTitle(session), tool ? `工具：${tool}` : '')
          return
        }

        if (type === 'tool/call') {
          const name = String(data.name || data.toolName || '')
          if (name === 'ask_user_question') alert('question', titles.get(sid) || pickTitle(session), '')
          else if (name === 'exit_plan_mode') alert('question', titles.get(sid) || pickTitle(session), '计划审批')
        }
      } catch (err) {
        // 提醒失败绝不影响会话
      }
    })

    ctx.effect(() => () => {
      try { if (typeof off === 'function') off() } catch (err) {}
      titles.clear()
      lastAlertAt.clear()
    })
  },
}
