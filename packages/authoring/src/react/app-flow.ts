import { useCallback, useMemo } from 'react';
import { useViewState } from './hooks.js';

export type AppFlowViewParams = Readonly<Record<string, unknown>>;

export type AppFlowOverlay<ViewName extends string> = {
  readonly view: ViewName;
  readonly mode: 'modal' | 'sheet' | 'detail';
  readonly params: AppFlowViewParams;
};

export type AppFlowConfig<ViewName extends string> = {
  readonly key?: string;
  readonly initialView: ViewName;
  readonly views?: readonly ViewName[];
};

export type AppFlowSnapshot<ViewName extends string> = {
  readonly activeView: ViewName;
  readonly params: AppFlowViewParams;
  readonly viewStack: readonly ViewName[];
  readonly overlayStack: readonly AppFlowOverlay<ViewName>[];
  readonly refreshToken: number;
};

export type AppFlow<ViewName extends string> = AppFlowSnapshot<ViewName> & {
  readonly canGoBack: boolean;
  readonly navigate: (view: ViewName, params?: AppFlowViewParams) => void;
  readonly replace: (view: ViewName, params?: AppFlowViewParams) => void;
  readonly back: () => void;
  readonly reset: (view?: ViewName, params?: AppFlowViewParams) => void;
  readonly refresh: () => void;
  readonly openOverlay: (
    view: ViewName,
    options?: {
      readonly mode?: AppFlowOverlay<ViewName>['mode'];
      readonly params?: AppFlowViewParams;
    },
  ) => void;
  readonly closeOverlay: () => void;
};

type FlowState<ViewName extends string> = {
  readonly activeView: ViewName;
  readonly paramsByView: Readonly<Record<string, AppFlowViewParams>>;
  readonly viewStack: readonly ViewName[];
  readonly overlayStack: readonly AppFlowOverlay<ViewName>[];
  readonly refreshToken: number;
};

export function useAppFlow<ViewName extends string>(
  config: AppFlowConfig<ViewName>,
): AppFlow<ViewName> {
  const stateKey = config.key ?? 'app_flow';
  const [state, setState] = useViewState<FlowState<ViewName>>(stateKey, {
    activeView: config.initialView,
    paramsByView: {},
    viewStack: [],
    overlayStack: [],
    refreshToken: 0,
  });
  const assertView = useCallback(
    (view: ViewName) => {
      if (config.views !== undefined && !config.views.includes(view)) {
        throw new Error(`Unknown app view "${view}"`);
      }
    },
    [config.views],
  );
  const navigate = useCallback(
    (view: ViewName, params: AppFlowViewParams = {}) => {
      assertView(view);
      setState((current) => ({
        ...current,
        activeView: view,
        paramsByView: { ...current.paramsByView, [view]: params },
        viewStack:
          current.activeView === view
            ? current.viewStack
            : [...current.viewStack, current.activeView],
      }));
    },
    [assertView, setState],
  );
  const replace = useCallback(
    (view: ViewName, params: AppFlowViewParams = {}) => {
      assertView(view);
      setState((current) => ({
        ...current,
        activeView: view,
        paramsByView: { ...current.paramsByView, [view]: params },
      }));
    },
    [assertView, setState],
  );
  const back = useCallback(() => {
    setState((current) => {
      if (current.overlayStack.length > 0) {
        return { ...current, overlayStack: current.overlayStack.slice(0, -1) };
      }
      const next = current.viewStack.at(-1);
      if (next === undefined) return current;
      return {
        ...current,
        activeView: next,
        viewStack: current.viewStack.slice(0, -1),
      };
    });
  }, [setState]);
  const reset = useCallback(
    (view: ViewName = config.initialView, params: AppFlowViewParams = {}) => {
      assertView(view);
      setState({
        activeView: view,
        paramsByView: { [view]: params },
        viewStack: [],
        overlayStack: [],
        refreshToken: 0,
      });
    },
    [assertView, config.initialView, setState],
  );
  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshToken: current.refreshToken + 1 }));
  }, [setState]);
  const openOverlay = useCallback(
    (
      view: ViewName,
      options: {
        readonly mode?: AppFlowOverlay<ViewName>['mode'];
        readonly params?: AppFlowViewParams;
      } = {},
    ) => {
      assertView(view);
      setState((current) => ({
        ...current,
        overlayStack: [
          ...current.overlayStack,
          { view, mode: options.mode ?? 'modal', params: options.params ?? {} },
        ],
      }));
    },
    [assertView, setState],
  );
  const closeOverlay = useCallback(() => {
    setState((current) => ({ ...current, overlayStack: current.overlayStack.slice(0, -1) }));
  }, [setState]);

  return useMemo(
    () => ({
      activeView: state.activeView,
      params: state.paramsByView[state.activeView] ?? {},
      viewStack: state.viewStack,
      overlayStack: state.overlayStack,
      refreshToken: state.refreshToken,
      canGoBack: state.viewStack.length > 0 || state.overlayStack.length > 0,
      navigate,
      replace,
      back,
      reset,
      refresh,
      openOverlay,
      closeOverlay,
    }),
    [back, closeOverlay, navigate, openOverlay, refresh, replace, reset, state],
  );
}
