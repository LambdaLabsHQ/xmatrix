package sh.xmatrix.app;

final class BridgeScript {
  static String source(String versionName) {
    String quotedVersion = quote(versionName);
    return
    "(() => {\n" +
    "  if (window.top !== window || window.xmatrixDesktop || !window.xmatrixNative) return;\n" +
    "  let nextRequestId = 1;\n" +
    "  const pending = new Map();\n" +
    "  const backListeners = new Set();\n" +
    "  window.xmatrixNative.onmessage = (event) => {\n" +
    "    try {\n" +
    "      const message = JSON.parse(String(event.data || '{}'));\n" +
    "      const request = pending.get(message.id);\n" +
    "      if (!request) return;\n" +
    "      pending.delete(message.id);\n" +
    "      const response = message.response || { ok: false, error: 'Native bridge error' };\n" +
    "      response.ok ? request.resolve(response.value) : request.reject(new Error(String(response.error || 'Native bridge error')));\n" +
    "    } catch (error) { console.error('Invalid Android bridge response', error); }\n" +
    "  };\n" +
    "  const invoke = (method, payload) => new Promise((resolve, reject) => {\n" +
    "    let id;\n" +
    "    try {\n" +
    "      id = `android-${nextRequestId++}`;\n" +
    "      pending.set(id, { resolve, reject });\n" +
    "      window.xmatrixNative.postMessage(JSON.stringify({ id, method, payload: payload || {} }));\n" +
    "    } catch (error) { if (id) pending.delete(id); reject(error); }\n" +
    "  });\n" +
    "  const disabledUpdateStatus = () => ({\n" +
    "    state: 'disabled', enabled: false, currentVersion: " + quotedVersion + ",\n" +
    "    message: 'Automatic updates are unavailable on Android.', updatedAt: new Date().toISOString()\n" +
    "  });\n" +
    "  window.xmatrixDesktop = {\n" +
    "    client: 'android',\n" +
    "    platform: 'android',\n" +
    "    getContext: () => invoke('getContext'),\n" +
    "    setBadge: (count) => invoke('setBadge', { count }),\n" +
    "    setTitle: (title) => invoke('setTitle', { title }),\n" +
    "    getNotificationSettings: () => invoke('getNotificationSettings'),\n" +
    "    requestNotifications: () => invoke('requestNotifications'),\n" +
    "    notify: (payload) => invoke('notify', payload),\n" +
    "    openExternal: (url) => invoke('openExternal', { url }),\n" +
    "    getClipboardImages: () => Promise.resolve([]),\n" +
    "    checkCliInstalled: () => Promise.resolve({ installed: false }),\n" +
    "    openCliInstall: () => invoke('openExternal', { url: '" + AppConfiguration.CLI_INSTALL_URL + "' }),\n" +
    "    onBackRequested: (listener) => {\n" +
    "      if (typeof listener !== 'function') return () => {};\n" +
    "      backListeners.add(listener);\n" +
    "      return () => backListeners.delete(listener);\n" +
    "    },\n" +
    "    __dispatchBackRequested: () => {\n" +
    "      for (const listener of Array.from(backListeners).reverse()) {\n" +
    "        try { if (listener() === true) return true; }\n" +
    "        catch (error) { console.error('Android back listener failed', error); }\n" +
    "      }\n" +
    "      return false;\n" +
    "    },\n" +
    "    checkForUpdates: () => Promise.resolve(disabledUpdateStatus()),\n" +
    "    getUpdateStatus: () => Promise.resolve(disabledUpdateStatus()),\n" +
    "    installUpdate: () => Promise.resolve(disabledUpdateStatus()),\n" +
    "    showUpdateNotification: (payload) => invoke('notify', payload || { title: 'xMatrix updates', body: 'Install updates from Google Play.' }),\n" +
    "    onUpdateStatus: (listener) => { Promise.resolve().then(() => listener(disabledUpdateStatus())); return () => {}; }\n" +
    "  };\n" +
    "})();";
  }

  private static String quote(String value) {
    String safe = value == null ? "" : value;
    return "'" + safe
      .replace("\\", "\\\\")
      .replace("'", "\\'")
      .replace("\r", "\\r")
      .replace("\n", "\\n") + "'";
  }

  private BridgeScript() {}
}
