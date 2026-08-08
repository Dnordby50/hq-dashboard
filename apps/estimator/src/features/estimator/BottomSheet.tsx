import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Prompt 76 Part C: the line editor's shell. A full-height BOTTOM SHEET under
// the breakpoint (the rep works from a phone in the driveway), a centered
// modal above it. This is the estimator PWA's OWN modal lifecycle, the THIRD
// one in the codebase next to index.html's #pecModalRoot and #prodModalRoot
// (CLAUDE.md gotcha): escape-to-close, focus trap, backdrop click, and scroll
// lock all live here and touch neither dashboard root.
//
// THE EMBED WRINKLE (prompt 61/71): inside the estimate detail page this app
// runs in an iframe that is sized to its full content height, so the iframe's
// "viewport" is the whole document and position:fixed would pin the sheet to
// the bottom of a several-thousand-pixel frame, off screen. The dashboard and
// the estimator are same-origin by construction, so the sheet computes the
// VISIBLE slice of the iframe from window.frameElement's rect against the
// parent viewport, positions absolutely inside that slice, and re-computes on
// parent scroll/resize. The parent page's scroll is locked while the sheet is
// open (restored on close), which is also what routes wheel/touch scrolling
// into the sheet's own overflow container instead of the page behind it.

type VisibleRect = { top: number; height: number };

function computeVisibleRect(): VisibleRect | null {
  try {
    const fe = window.frameElement as HTMLElement | null;
    if (!fe) return null; // not framed: fixed positioning is correct
    const r = fe.getBoundingClientRect();
    const parentVh = window.parent.innerHeight;
    const visTop = Math.max(0, -r.top);
    const visBottom = Math.min(r.height, parentVh - r.top);
    // Never smaller than a usable card, even when the iframe is barely on
    // screen (the open scrolled it into view a moment ago).
    return { top: visTop, height: Math.max(320, visBottom - visTop) };
  } catch {
    return null; // cross-origin or no parent: behave like standalone
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function BottomSheet({
  open,
  onClose,
  title,
  breakpointPx,
  focusSelector,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  // Sheet vs centered-modal switch (Part G3 tunable, settings-backed).
  breakpointPx: number;
  // CSS selector focused on open (the send-gate deep link asks for the
  // description); falls back to the first focusable field.
  focusSelector?: string | null;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<VisibleRect | null>(null);
  const framed = typeof window !== 'undefined' && !!window.frameElement;

  // Track the visible slice while framed (see the header comment).
  useLayoutEffect(() => {
    if (!open || !framed) { setRect(null); return; }
    const update = () => setRect(computeVisibleRect());
    update();
    let parentWin: Window | null = null;
    try { parentWin = window.parent; } catch { parentWin = null; }
    try {
      parentWin?.addEventListener('scroll', update, true);
      parentWin?.addEventListener('resize', update);
    } catch { /* cross-origin */ }
    window.addEventListener('resize', update);
    return () => {
      try {
        parentWin?.removeEventListener('scroll', update, true);
        parentWin?.removeEventListener('resize', update);
      } catch { /* cross-origin */ }
      window.removeEventListener('resize', update);
    };
  }, [open, framed]);

  // Scroll lock: this document always; the PARENT document too when framed,
  // which is what keeps the visible slice stable and sends wheel/touch
  // scrolling to the sheet instead of the page behind it (prompt 71's
  // iframe-scroll lesson). Both restored on close, whatever they were.
  useEffect(() => {
    if (!open) return;
    const prevown = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let parentBody: HTMLElement | null = null;
    let parentHtml: HTMLElement | null = null;
    let prevParentBody = '';
    let prevParentHtml = '';
    try {
      if (framed && window.parent?.document?.body) {
        parentBody = window.parent.document.body;
        prevParentBody = parentBody.style.overflow;
        parentBody.style.overflow = 'hidden';
        // Belt and braces: body{overflow:hidden} only reaches the viewport
        // when html's overflow is visible (propagation), so lock the
        // documentElement too in case the dashboard ever styles it.
        parentHtml = window.parent.document.documentElement;
        prevParentHtml = parentHtml.style.overflow;
        parentHtml.style.overflow = 'hidden';
      }
    } catch { /* cross-origin: nothing to lock */ }
    return () => {
      document.body.style.overflow = prevown;
      if (parentBody) { try { parentBody.style.overflow = prevParentBody; } catch { /* gone */ } }
      if (parentHtml) { try { parentHtml.style.overflow = prevParentHtml; } catch { /* gone */ } }
    };
  }, [open, framed]);

  // Focus on open + restore on close. The trap below keeps Tab inside.
  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const host = sheetRef.current;
      if (!host) return;
      const target = (focusSelector ? host.querySelector<HTMLElement>(focusSelector) : null)
        ?? host.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
      if (target && 'select' in target && typeof (target as HTMLInputElement).select === 'function' && target.tagName === 'TEXTAREA') {
        // Put the caret at the end instead of selecting everything.
        const ta = target as HTMLTextAreaElement;
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* number inputs etc. */ }
      }
    }, 30);
    return () => {
      window.clearTimeout(t);
      try { prevActive?.focus(); } catch { /* removed */ }
    };
  }, [open, focusSelector]);

  // Escape closes; Tab wraps (the focus trap).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const host = sheetRef.current;
      if (!host) return;
      const focusables = Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !host.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !host.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const wide = window.innerWidth >= breakpointPx;
  // Framed: absolute inside the visible slice. Standalone: fixed as usual.
  const overlayStyle: React.CSSProperties = framed
    ? { position: 'absolute', top: 0, left: 0, right: 0, height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }
    : { position: 'fixed', inset: 0 };
  const slice: VisibleRect = framed
    ? (rect ?? { top: 0, height: window.innerHeight })
    : { top: 0, height: window.innerHeight };
  const sheetStyle: React.CSSProperties = wide
    ? {
        position: framed ? 'absolute' : 'fixed',
        top: slice.top + 28,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(600px, 94vw)',
        maxHeight: Math.max(280, slice.height - 56),
      }
    : {
        position: framed ? 'absolute' : 'fixed',
        top: slice.top + 20,
        left: 0,
        right: 0,
        height: Math.max(300, slice.height - 20),
      };

  return (
    <div className="sheet-overlay" style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={sheetRef}
        className={wide ? 'sheet sheet-modal' : 'sheet sheet-bottom'}
        style={sheetStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-head">
          <strong>{title}</strong>
          <button type="button" className="sheet-close" aria-label="Close line editor" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
