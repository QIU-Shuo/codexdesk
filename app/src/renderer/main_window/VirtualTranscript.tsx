import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * Virtualized transcript with stick-to-bottom behavior.
 *
 * Two things make this harder than a normal virtual list, and both are why
 * the plan puts it in Phase 2 rather than later (§5, step 2.2):
 *
 * - **Rows resize while streaming.** Deltas append text continuously, so row
 *   heights are not stable. `measureElement` re-measures on every change.
 * - **Scroll anchoring is not free.** Content grows at the bottom constantly;
 *   "stick to bottom unless the user scrolled up" has to be explicit, or the
 *   view either fights the user or drifts away from the live output.
 */
export function VirtualTranscript({
  count,
  renderRow,
  /** Bump to re-pin to the bottom (e.g. new streamed text). */
  revision,
}: {
  count: number;
  renderRow: (index: number) => React.ReactNode;
  revision: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    // Rough starting guess; real heights come from measureElement.
    estimateSize: () => 90,
    overscan: 8,
  });

  // Distinguish "user scrolled up" from our own programmatic scrolling: only
  // proximity to the bottom decides, so a scroll we caused keeps it pinned.
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStick(distance < 40);
  }, []);

  useLayoutEffect(() => {
    if (!stick || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [count, revision, stick, virtualizer]);

  // A resize changes what "at the bottom" means; re-pin rather than drift.
  useEffect(() => {
    if (!stick) return;
    // Electron provides this, but the renderer's non-layout test/runtime
    // environments may not. Streaming still works there; only resize-driven
    // re-pinning is unavailable.
    if (typeof ResizeObserver === "undefined") return;
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [stick, count, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={parentRef} onScroll={onScroll}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {items.map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="row">{renderRow(virtualRow.index)}</div>
            </div>
          ))}
        </div>
      </div>
      {!stick && (
        <button
          className="jump"
          onClick={() => {
            setStick(true);
            if (count > 0) {
              virtualizer.scrollToIndex(count - 1, { align: "end" });
            }
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
