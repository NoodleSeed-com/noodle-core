import open from 'open';

export type UrlOpener = (url: string) => unknown | Promise<unknown>;

export interface PresentUrlOptions {
  readonly shouldOpen?: boolean;
  readonly open?: UrlOpener;
  readonly print?: (url: string) => void;
  readonly warn?: (message: string) => void;
}

/** Print a browser handoff URL first, then make a best-effort launch without hiding the fallback. */
export async function presentUrl(url: string, options: PresentUrlOptions = {}): Promise<boolean> {
  const print = options.print ?? console.log;
  print(url);
  if (options.shouldOpen === false) return false;

  try {
    await (options.open ?? open)(url);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    (options.warn ?? console.error)(
      `Could not open a browser (${detail}). Open the URL printed above manually.`,
    );
    return false;
  }
}
