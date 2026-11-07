/**
 * 预加载脚本：只暴露"我是桌面版"这一层最小信息。
 * 不向页面暴露任何 Node / Electron API（窗口开启了 contextIsolation + sandbox）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beaverDesktop', {
  isDesktop: true,
  platform: process.platform,
  appVersion: process.env.npm_package_version || '',

  /**
   * 上报未读数（可选接入）。
   * 网页端调用 window.beaverDesktop.setUnread(3) 后，
   * 托盘提示 / macOS Dock 角标 / Windows 任务栏角标会同步。
   */
  setUnread(count) {
    const n = Number(count);
    if (Number.isFinite(n)) ipcRenderer.send('beaver:unread', Math.max(0, Math.trunc(n)));
  },
});
