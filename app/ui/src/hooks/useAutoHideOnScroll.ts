import { useEffect, useState } from "react";

/**
 * @description Tracks page-level (window) scrolling so an overlay pinned to
 * the edge of the screen can get out of the way: reports false while the
 * user scrolls down, and true again as soon as they scroll back up (or are
 * at the very top). In windows that never scroll (e.g. the desktop app,
 * whose panels scroll internally) it stays true.
 */
function useAutoHideOnScroll() {
    const [ visible, setVisible ] = useState(true);

    useEffect(() => {
        let lastY = window.scrollY;
        let hidden = lastY > 1;

        function onScroll() {
            const y = window.scrollY;
            const delta = y - lastY;
            lastY = y;

            // Ignore sub-pixel jitter (e.g. scroll anchoring events).
            if (Math.abs(delta) < 2 && y > 1) return;

            // At the top the overlay is always visible; otherwise it hides
            // on scroll down and reappears on scroll up.
            const nextHidden = y <= 1 ? false : delta > 0;

            if (nextHidden !== hidden) {
                hidden = nextHidden;
                setVisible(!hidden);
            }
        }

        window.addEventListener("scroll", onScroll, { passive: true });

        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    return visible;
}

export default useAutoHideOnScroll;