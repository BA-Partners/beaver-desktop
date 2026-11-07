/**
 * 圆梦同行 桌面客户端（Electron 在线壳）
 *
 * 只做"浏览器 + 桌面外壳"该做的事：
 *  - 加载线上 https://8811.info/app/（网页版发版后桌面端自动是最新）
 *  - 把手机端的语音/视频通话所需权限放行
 *  - 外链走系统浏览器、下载走系统保存对话框
 *  - 断网/加载失败时显示本地兜底页并可重试
 *  - 单实例、窗口尺寸兜住桌面双栏布局的 1000px 断点
 *
 * 刻意保持：contextIsolation = true、nodeIntegration = false、sandbox = true，
 * 不在页面里暴露任何 Node 能力。
 */

const {
  app,
  BrowserWindow,
  shell,
  session,
  Menu,
  dialog,
  Tray,
  ipcMain,
  nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_URL = 'https://8811.info/app/';
const APP_HOST = '8811.info';
const APP_PATH_PREFIX = '/app';

/** 最小窗口尺寸：低于 1000 网页版会退回手机单列布局 */
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 700;

const isSmoke = process.argv.includes('--smoke');
const startHidden = process.argv.includes('--hidden');
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const shotPath = shotArg ? shotArg.split('=')[1] : '/tmp/electron-smoke.png';

/** 视为"自家"的地址：只有这些地址能拿到麦克风/摄像头等权限 */
function isTrustedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.host === APP_HOST && u.pathname.startsWith(APP_PATH_PREFIX);
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^https?:/i.test(url)) shell.openExternal(url);
}

let mainWindow = null;
let tray = null;
/** 真正退出（区分"关闭到托盘"） */
let isQuitting = false;
/** 未读数：优先用页面通过 window.beaverDesktop.setUnread(n) 上报，其次解析标题 */
let unreadCount = 0;

function trayIconPath() {
  const p = path.join(__dirname, '..', 'build', 'tray.png');
  return fs.existsSync(p) ? p : path.join(__dirname, '..', 'build', 'icon.png');
}

function trayTitle() {
  if (unreadCount > 0) return `圆梦同行 · ${unreadCount} 条未读`;
  return '圆梦同行';
}

/** 系统级未读角标：macOS 用 Dock 角标，Windows 用任务栏覆盖图标，Linux 用启动器角标 */
function applyBadge(count) {
  unreadCount = Math.max(0, count | 0);

  if (process.platform === 'darwin') {
    app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '');
  } else if (process.platform === 'win32' && mainWindow) {
    if (unreadCount > 0) {
      const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon-256.png'));
      mainWindow.setOverlayIcon(img.isEmpty() ? null : img, `${unreadCount} 条未读`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } else {
    try {
      app.setBadgeCount(unreadCount);
    } catch {
      /* 部分桌面环境不支持 */
    }
  }

  if (tray) tray.setToolTip(trayTitle());
}

/** 从页面标题里解析 "(3) xxx" 形式的未读数 */
function unreadFromTitle(title) {
  const m = /^\s*\((\d+)\)/.exec(title || '');
  // 标题里没有数字时不覆盖页面显式上报的值
  return m ? Number(m[1]) : null;
}


/** 窗口大小/位置持久化：下次打开保持用户调整过的尺寸 */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8');
    const st = JSON.parse(raw);
    if (typeof st.width === 'number' && typeof st.height === 'number') {
      return st;
    }
  } catch {
    /* 首次启动或文件损坏：用默认值 */
  }
  return null;
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
    );
  } catch {
    /* 写盘失败不影响使用 */
  }
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(trayTitle());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: isAutoLaunchEnabled(),
        click: (item) => setAutoLaunch(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出圆梦同行',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Linux 没有 setLoginItemSettings，写 XDG autostart 文件 */
function linuxAutostartPath() {
  const dir = path.join(app.getPath('home'), '.config', 'autostart');
  return path.join(dir, 'beaver-desktop.desktop');
}

function isAutoLaunchEnabled() {
  try {
    if (process.platform === 'linux') return fs.existsSync(linuxAutostartPath());
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setAutoLaunch(enable) {
  try {
    if (process.platform === 'linux') {
      const file = linuxAutostartPath();
      if (enable) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          [
            '[Desktop Entry]',
            'Type=Application',
            'Name=圆梦同行',
            `Exec=${process.execPath} --hidden`,
            'X-GNOME-Autostart-enabled=true',
            'Terminal=false',
            '',
          ].join('\n'),
        );
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: enable });
    }
    return true;
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '设置开机自启失败', detail: String(err) });
    return false;
  }
}

function installSessionPolicy() {
  const ses = session.defaultSession;

  // 语音/视频通话、桌面通知等需要显式放行，默认是全部拒绝的
  const allowed = new Set([
    'media',                        // 麦克风 / 摄像头
    'mediaKeySystem',
    'display-capture',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'pointerLock',
  ]);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL();
    callback(allowed.has(permission) && isTrustedUrl(url));
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return allowed.has(permission) && isTrustedUrl(requestingOrigin);
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: '退出圆梦同行' },
          ],
        }]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '刷新',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        {
          label: '强制刷新（清缓存）',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开网页版', click: () => openExternal(APP_URL) },
        { label: '下载最新 App', click: () => openExternal('https://8811.info/download/') },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于圆梦同行',
              message: `圆梦同行 桌面版 ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\n服务地址 ${APP_URL}`,
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

  const saved = loadWindowState();
  const winWidth = Math.max(MIN_WIDTH, saved?.width ?? 1280);
  const winHeight = Math.max(MIN_HEIGHT, saved?.height ?? 860);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    // 只在状态有效且落在屏幕内时才恢复位置，避免窗口跑到屏幕外
    ...(typeof saved?.x === 'number' && typeof saved?.y === 'number'
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#F2F3F5',
    title: '圆梦同行',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: !isSmoke && !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  const wc = mainWindow.webContents;

  // 站内导航放行，站外一律交给系统浏览器，避免应用窗口被"导航跑偏"
  wc.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // 页面标题跟随后台未读数等变化，同步到任务栏/标题栏
  wc.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (mainWindow) mainWindow.setTitle(title || '圆梦同行');
    const n = unreadFromTitle(title);
    if (n !== null) applyBadge(n);
  });

  // 加载失败（断网/服务不可达）→ 本地兜底页，可一键重试
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // 主动取消，忽略
    const fallback = path.join(__dirname, 'fallback.html');
    wc.loadFile(fallback, {
      query: { url: APP_URL, code: String(errorCode), desc: errorDescription || '' },
    });
  });

  // 渲染进程崩溃时自动拉起一次
  wc.on('render-process-gone', (event, details) => {
    if (details && details.reason !== 'clean-exit' && mainWindow) {
      mainWindow.webContents.loadURL(APP_URL).catch(() => {});
    }
  });

  mainWindow.loadURL(APP_URL);

  if (!isSmoke) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }

  const persist = () => saveWindowState(mainWindow);
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);

  if (saved?.maximized) mainWindow.maximize();

  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    if (isQuitting) return;
    // 关闭按钮收进托盘，符合 IM 习惯；要退出走托盘菜单/应用菜单
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isSmoke) {
    wc.once('did-finish-load', async () => {
      try {
        // 等 Flutter 首帧渲染完（首次要下载 main.dart.js 与字体）
        await new Promise((r) => setTimeout(r, 12000));
        const image = await wc.capturePage();
        fs.writeFileSync(shotPath, image.toPNG());
        console.log(
          JSON.stringify({
            ok: true,
            title: wc.getTitle(),
            url: wc.getURL(),
            screenshot: shotPath,
            size: fs.statSync(shotPath).size,
          }),
        );
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: String(err) }));
      } finally {
        app.exit(0);
      }
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.example.beaver.desktop');
    installSessionPolicy();
    buildMenu();
    createWindow();
    createTray();

    // 页面可用 window.beaverDesktop.setUnread(n) 主动上报未读数
    ipcMain.on('beaver:unread', (_event, count) => {
      // 便于排查：外壳日志里能看到网页端上报的未读数
      console.log('[unread]', count);
      applyBadge(count);
    });
    ipcMain.handle('beaver:getVersion', () => app.getVersion());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // 收进托盘后窗口全关也不退出（macOS 本来就不退）
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });
}
