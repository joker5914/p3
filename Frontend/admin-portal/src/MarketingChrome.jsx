import { useEffect, useState } from "react";
import "./MarketingChrome.css";

/* ── Marketing chrome ────────────────────────────────────────────────
   Shared viewport furniture for the public site (/, /trust):

   • <ReadingProgress>   — citrus gradient bar at the top edge that
                           fills as you scroll the document.
   • <BackToTop>         — floating action button bottom-right that
                           appears after you've scrolled past the hero.
   • useScrollSpy(ids)   — IntersectionObserver hook that tells you
                           which in-page section the reader is in, so
                           the matching nav link can underline itself.

   Lives in its own file so /trust can pick it up without re-importing
   the entire marketing page.
   ────────────────────────────────────────────────────────────────── */

export default function MarketingChrome() {
  return (
    <>
      <ReadingProgress />
      <BackToTop />
    </>
  );
}

function ReadingProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const next = max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0;
      setProgress(next);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="mc-progress" aria-hidden="true">
      <div className="mc-progress-bar" style={{ width: `${progress}%` }} />
    </div>
  );
}

function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only show once the reader has clearly committed to scrolling — past
    // the hero, roughly one viewport down.  Avoids the FAB flashing in for
    // a tiny scroll offset.
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      className={`mc-totop${visible ? " is-visible" : ""}`}
      onClick={scrollToTop}
      aria-label="Back to top"
      tabIndex={visible ? 0 : -1}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}

/**
 * Returns the id of the section currently in the reader's viewport, or
 * null when no observed section is in view.  Uses a "trigger band"
 * 30%–60% down the viewport: a section becomes active when its top edge
 * crosses the top of the band.  When no section is intersecting (e.g.
 * between sections), the previous active id is held to avoid flicker.
 */
export function useScrollSpy(ids) {
  const [active, setActive] = useState(null);

  // Stable dep so adding/removing ids doesn't tear down the observer
  // every render.
  const key = ids.join("|");

  useEffect(() => {
    if (!ids.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return; // hold previous active to avoid flicker
        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        );
        setActive(topmost.target.id);
      },
      {
        // Only count a section as "in view" once its top crosses 30%
        // down the viewport, and ignore once it's left the bottom 40%.
        rootMargin: "-30% 0px -60% 0px",
        threshold: 0,
      }
    );

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return active;
}
