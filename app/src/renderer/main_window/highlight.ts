import type { Highlighter } from "shiki";

/**
 * Syntax highlighting for the file viewer. Shiki uses TextMate grammars; a
 * regex tokenizer mislabels enough non-trivial code to stop being useful.
 *
 * Three things this module exists to hold:
 *
 * 1. **One highlighter, lazily created.** Loading grammars is expensive and
 *    the viewer re-renders on every keystroke in the find box.
 * 2. **Per-language lazy loading.** Bundling ~200 grammars up front costs far
 *    more than the viewer is worth; we load a grammar the first time a file
 *    needs it.
 * 3. **Failure is not fatal.** A missing grammar, or shiki failing to load at
 *    all, must degrade to unhighlighted text — never to an empty viewer.
 */

let highlighterPromise: Promise<Highlighter | null> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();

/**
 * Both themes are loaded together so toggling appearance does not re-create
 * the highlighter. They are shiki's own; §5 of the note leaves the palette
 * open, and these at least meet contrast in their respective modes.
 */
const THEMES = { light: "github-light", dark: "github-dark" } as const;

export type Appearance = keyof typeof THEMES;

async function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki")
      .then((shiki) =>
        shiki.createHighlighter({
          themes: [THEMES.light, THEMES.dark],
          // Grammars arrive per-language via `loadLanguage`.
          langs: [],
          /*
            **The JavaScript regex engine, not the default Oniguruma one.**

            Shiki's default engine is WebAssembly, and our CSP is
            `default-src 'self'` — instantiating Wasm needs `unsafe-eval`, so
            it threw `CompileError` and every file rendered as plain text.
            Verified by reading the renderer console in the packaged app;
            nothing in a jsdom test surfaces it, because there is no CSP there.

            Loosening the CSP was the other option and is the wrong one: an
            `unsafe-eval` renderer is a real security regression, and this
            engine handles every grammar we ship (checked against markdown,
            typescript, tsx, json, yaml, shellscript, rust, python, css).
          */
          engine: shiki.createJavaScriptRegexEngine(),
        }),
      )
      .catch(() => null);
  }
  return highlighterPromise;
}

/**
 * Ensure a grammar is available. Resolves false when the language is unknown
 * or loading failed, which the caller treats as "render plain".
 *
 * Concurrent calls for the same language share one load: the viewer can mount
 * twice for the same file (tree click plus a deep link) before the first
 * finishes.
 */
export async function ensureLanguage(language: string): Promise<boolean> {
  if (language === "text" || !language) return false;
  if (loaded.has(language)) return true;

  const inFlight = loading.get(language);
  if (inFlight) return inFlight;

  const load = (async () => {
    const hl = await getHighlighter();
    if (!hl) return false;
    try {
      await hl.loadLanguage(language as Parameters<typeof hl.loadLanguage>[0]);
      loaded.add(language);
      return true;
    } catch {
      // An unknown language id is expected, not exceptional: `detectLanguage`
      // returns ids from our own table, which can drift from shiki's set.
      return false;
    } finally {
      loading.delete(language);
    }
  })();

  loading.set(language, load);
  return load;
}

/**
 * Highlight one line to HTML, or return null to render it as plain text.
 *
 * Per line rather than per file on purpose: the viewer owns the gutter and the
 * line elements, because line anchors have to survive highlighting for deep
 * links and scroll-to-match to work (§3.1). Handing shiki the whole file gives
 * back a `<pre>` whose structure we would then have to parse apart.
 */
export function highlightLine(
  line: string,
  language: string,
  appearance: Appearance,
): string | null {
  if (!loaded.has(language)) return null;
  // `getHighlighter` has resolved if the language loaded, so this is sync.
  const hl = syncHighlighter;
  if (!hl) return null;
  try {
    const html = hl.codeToHtml(line, {
      lang: language,
      theme: THEMES[appearance],
      structure: "inline",
    });
    return html;
  } catch {
    return null;
  }
}

/**
 * The resolved highlighter, kept for the synchronous `highlightLine`.
 *
 * `codeToHtml` is synchronous once grammars are in, but the handle arrives
 * through a promise. Rendering is a hot path — a React render cannot await —
 * so the resolved value is stashed here and `highlightLine` reads it.
 */
let syncHighlighter: Highlighter | null = null;
void getHighlighter().then((hl) => {
  syncHighlighter = hl;
});
