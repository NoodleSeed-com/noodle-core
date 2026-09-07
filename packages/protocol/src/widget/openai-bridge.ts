/** ChatGPT/OpenAI host adapter source spliced into the shared widget bootstrap. */
export const OPENAI_WIDGET_BRIDGE_SOURCE: string = `
  function makeOpenAiApp(o) {
    const msgText = (m) => (m && m.content && m.content[0] && m.content[0].text) || '';
    let latestModelContent = o.widgetState && typeof o.widgetState === 'object' &&
      Object.prototype.hasOwnProperty.call(o.widgetState, 'modelContent')
      ? o.widgetState.modelContent
      : null;
    const widgetPrivateContent = () => {
      const s = o.widgetState;
      return s && typeof s === 'object' && s.privateContent && typeof s.privateContent === 'object'
        ? s.privateContent
        : s && typeof s === 'object' ? s : {};
    };
    const modelContent = (p) =>
      p && p.structuredContent !== undefined
        ? p.structuredContent
        : p && p.content && p.content[0] && p.content[0].text ? p.content[0].text : null;
    const app = {
      // Fall back to ChatGPT globals when callTool does not return a CallToolResult-shaped value.
      callServerTool: (req) =>
        Promise.resolve(o.callTool(req.name, req.arguments)).then((r) =>
          r && typeof r === 'object' && ('structuredContent' in r || 'content' in r || '_meta' in r)
            ? r
            : { structuredContent: o.toolOutput, _meta: o.toolResponseMetadata }),
      sendMessage: (m) =>
        typeof o.sendFollowUpMessage === 'function' ? o.sendFollowUpMessage({ prompt: msgText(m) }) : undefined,
      openLink: (p) => (typeof o.openExternal === 'function' ? o.openExternal({ href: p && p.url }) : undefined),
      requestDisplayMode: (p) =>
        typeof o.requestDisplayMode === 'function' ? o.requestDisplayMode({ mode: p && p.mode }) : undefined,
      getWidgetState: () => {
        const current = o.widgetState && typeof o.widgetState === 'object' ? o.widgetState : {};
        return { ...current, modelContent: latestModelContent };
      },
      setWidgetState: (p) => {
        if (p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'modelContent')) {
          latestModelContent = p.modelContent;
        }
        return typeof o.setWidgetState === 'function' ? o.setWidgetState(p) : undefined;
      },
      updateModelContext: (p) => {
        latestModelContent = modelContent(p);
        if (typeof o.updateModelContext === 'function') return o.updateModelContext(p);
        if (typeof o.setWidgetState !== 'function') return undefined;
        return o.setWidgetState({
          modelContent: latestModelContent,
          privateContent: widgetPrivateContent(),
          imageIds: o.widgetState && Array.isArray(o.widgetState.imageIds) ? o.widgetState.imageIds : [],
        });
      },
      getHostContext: () => ({ theme: o.theme, displayMode: o.displayMode, locale: o.locale }),
      getHostCapabilities: () => ({
        tools: typeof o.callTool === 'function',
        openLink: typeof o.openExternal === 'function',
        displayMode: typeof o.requestDisplayMode === 'function',
        message: typeof o.sendFollowUpMessage === 'function',
        modelContext: typeof o.updateModelContext === 'function' || typeof o.setWidgetState === 'function',
      }),
      connect: () => {
        // Surface host globals into the same handlers the ext-apps path uses.
        const push = () => {
          if (typeof app.ontoolinput === 'function' && o.toolInput !== undefined) {
            app.ontoolinput({ arguments: o.toolInput });
          }
          if (
            typeof app.ontoolresult === 'function' &&
            o.__noodleDevtools === true &&
            o.__noodleToolResult != null
          ) {
            app.ontoolresult(o.__noodleToolResult);
          } else if (
            typeof app.ontoolresult === 'function' &&
            (o.toolOutput !== undefined || o.toolResponseMetadata !== undefined)
          ) {
            app.ontoolresult({ structuredContent: o.toolOutput, _meta: o.toolResponseMetadata });
          }
        };
        try {
          globalThis.addEventListener('openai:set_globals', () => {
            push();
            if (typeof app.onhostcontextchanged === 'function') app.onhostcontextchanged({ theme: o.theme });
          });
        } catch (e) {}
        push();
        return Promise.resolve();
      },
    };
    return app;
  }
  function makeWidgetApp(E, oai) {
    if (oai && oai.__noodleDevtools === true && typeof oai.callTool === 'function') {
      return makeOpenAiApp(oai);
    }
    if (E && E.App) return new E.App({ name: 'noodle-widget', version: '1' }, {}, { autoResize: true });
    return oai && typeof oai.callTool === 'function' ? makeOpenAiApp(oai) : null;
  }
`;
