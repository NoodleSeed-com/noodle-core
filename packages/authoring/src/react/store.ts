import { useCallback, useMemo } from 'react';
import { useViewState } from './hooks.js';

export type StoreHookResult<State, Selected = State> = {
  readonly state: State;
  readonly selected: Selected;
  readonly setState: (value: State | ((current: State) => State)) => void;
  readonly patchState: State extends object
    ? (value: Partial<State> | ((current: State) => Partial<State>)) => void
    : never;
  readonly getState: () => State;
};

export function createViewStore<State>(
  key: string,
  initializer: State | (() => State),
): <Selected = State>(selector?: (state: State) => Selected) => StoreHookResult<State, Selected> {
  return function useStore<Selected = State>(
    selector?: (state: State) => Selected,
  ): StoreHookResult<State, Selected> {
    const initialState = useMemo(
      () => (typeof initializer === 'function' ? (initializer as () => State)() : initializer),
      [],
    );
    const [state, setState] = useViewState<State>(key, initialState);
    const patchState = useCallback(
      (value: Partial<State> | ((current: State) => Partial<State>)) => {
        setState(
          (current) =>
            ({
              ...(current as Record<string, unknown>),
              ...(typeof value === 'function'
                ? (value as (current: State) => Partial<State>)(current)
                : value),
            }) as State,
        );
      },
      [setState],
    );
    const selected = selector === undefined ? (state as unknown as Selected) : selector(state);
    return {
      state,
      selected,
      setState,
      patchState: patchState as StoreHookResult<State, Selected>['patchState'],
      getState: () => state,
    };
  };
}
