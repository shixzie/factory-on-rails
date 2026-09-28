"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the bottom (px) still counts as "at the bottom". */
const THRESHOLD = 96;

const distanceFromBottom = () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);

/**
 * Keeps the page pinned to the newest activity while a run is live, the way a
 * chat or a terminal does: whenever `version` moves on (new events), it
 * scrolls to the end. Scrolling up (wheel, touch, keys or the scrollbar)
 * pauses following; coming back to the bottom, or `jump()`, resumes it.
 * `unseen` says whether activity arrived while paused, for a "jump to latest"
 * button. Expanding a block doesn't count as activity, so opening something
 * near the bottom never yanks the page away from it.
 */
export function useFollow(version: number, enabled: boolean) {
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const followingRef = useRef(true);
  const seen = useRef(version);

  const set = useCallback((on: boolean) => {
    followingRef.current = on;
    setFollowing(on);
    if (on) setUnseen(false);
  }, []);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
  }, []);

  // The reader's own scrolling decides whether we follow.
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const up = y < lastY - 2;
      lastY = y;
      if (distanceFromBottom() <= THRESHOLD) {
        if (!followingRef.current) set(true);
      } else if (up && followingRef.current) {
        set(false);
      }
    };
    // Intent to scroll up pauses following at once, even mid smooth-scroll.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && followingRef.current) set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) && followingRef.current) set(false);
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => void (touchY = e.touches[0]?.clientY ?? 0);
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) > touchY + 8 && followingRef.current) set(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [set]);

  // New activity: stay at the end, or note it for the jump button.
  useLayoutEffect(() => {
    if (version === seen.current) return;
    seen.current = version;
    if (!enabled) return;
    if (followingRef.current) requestAnimationFrame(() => scrollToEnd(true));
    else setUnseen(true);
  }, [version, enabled, scrollToEnd]);

  // Open a live run at its newest activity.
  useEffect(() => {
    if (enabled) scrollToEnd(false);
  }, [enabled, scrollToEnd]);

  const jump = useCallback(() => {
    set(true);
    scrollToEnd(true);
  }, [set, scrollToEnd]);

  return { following, unseen, jump };
}
