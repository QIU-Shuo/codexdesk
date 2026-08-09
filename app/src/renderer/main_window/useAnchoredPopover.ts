import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/** Keep a composer popover above its trigger without crossing window edges. */
export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  gap = 8,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }

    const place = () => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const margin = 12;
      const anchorBox = anchor.getBoundingClientRect();
      const width = popover.getBoundingClientRect().width;
      const left = Math.min(
        Math.max(margin, anchorBox.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      setStyle({
        position: "fixed",
        left,
        bottom: Math.max(margin, window.innerHeight - anchorBox.top + gap),
      });
    };

    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef, gap, open, popoverRef]);

  return style;
}
