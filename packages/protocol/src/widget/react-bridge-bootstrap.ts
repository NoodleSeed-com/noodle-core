/** React helper bridge source injected into the shared widget bootstrap. */
export const WIDGET_REACT_BRIDGE_SOURCE = `
  function notifyReact(eventName) {
    globalThis.__noodleReactVersion = (globalThis.__noodleReactVersion || 0) + 1;
    try { globalThis.dispatchEvent(new CustomEvent(eventName)); } catch (e) {}
  }
  function installReactBridge() {
    globalThis.__noodleReactBridge = {
      getToolResult: () => globalThis.__noodleToolResult || {},
      getViewState: () => stateData(),
      setWidgetState: (patch) => setState(patch || {}),
      getLayout: () => {
        const context = (app.getHostContext && app.getHostContext()) || globalThis.__noodleLayout || {};
        const capabilities = (app.getHostCapabilities && app.getHostCapabilities()) || {};
        const hostInfo = (app.getHostVersion && app.getHostVersion()) || {};
        const modes = Array.isArray(context.availableDisplayModes)
          ? context.availableDisplayModes.filter((mode) => mode === 'inline' || mode === 'fullscreen' || mode === 'pip')
          : [];
        return {
          theme: context.theme === 'dark' ? 'dark' : 'light',
          displayMode: context.displayMode === 'fullscreen' || context.displayMode === 'pip'
            ? context.displayMode
            : 'inline',
          ...(modes.length ? { availableDisplayModes: modes } : {}),
          ...(context.containerDimensions ? { containerDimensions: { ...context.containerDimensions } } : {}),
          ...(context.locale ? { locale: context.locale } : {}),
          ...(context.timeZone ? { timeZone: context.timeZone } : {}),
          ...(hostInfo.name ? { host: String(hostInfo.name) } : {}),
          ...(context.platform ? { platform: context.platform } : {}),
          ...(context.deviceCapabilities ? { deviceCapabilities: { ...context.deviceCapabilities } } : {}),
          ...(context.safeAreaInsets ? { safeAreaInsets: { ...context.safeAreaInsets } } : {}),
          supports: {
            fullscreen: modes.includes('fullscreen'),
            pip: modes.includes('pip'),
            openExternal: Boolean(capabilities.openLinks || capabilities.openLink),
            followUpMessage: Boolean(capabilities.message),
            modelContext: Boolean(capabilities.updateModelContext || capabilities.modelContext),
          },
        };
      },
      getBranding: () => globalThis.__noodleBranding || {},
      callServerTool: (request) => app.callServerTool({
        name: request && request.name,
        arguments: request ? request.arguments : undefined,
      }),
      openExternal: (url) => app.openLink({ url: String(url || '') }),
      sendFollowUpMessage: (message) => app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: String((message && message.prompt) || '') }],
      }),
      updateModelContext: (update) => app.updateModelContext(update || {}),
      requestDisplayMode: (mode) => app.requestDisplayMode({ mode }),
    };
    notifyReact('noodle:bridge');
  }
`;
