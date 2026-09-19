import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

/* The box a customer signs in, built for phones first.
 *
 * The old pad broke on every phone in three ways:
 *  1. The canvas drew at a fixed 620 pixels while a phone shows it about 340
 *     wide, so the ink landed up and to the left of the finger, half size.
 *  2. React's touch handlers are passive, so preventDefault did nothing and a
 *     finger could scroll the page instead of drawing.
 *  3. Nothing to fall back on if drawing still fails.
 * Now: pointer events with capture (touch, pen and mouse alike), a native
 * non-passive touch listener so the page holds still, the canvas sized to what
 * is actually on screen, every point mapped by the real scale, and a typed
 * signature as a fallback.
 *
 * Parent reads it through the ref: isEmpty(), toDataURL(), clear(),
 * signWithName(name). onChange(hasInk) fires when ink appears or is cleared.
 */
const SignaturePad = forwardRef(function SignaturePad({ onChange }, ref) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const inked = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const mark = (v) => { inked.current = v; setHasInk(v); onChange?.(v); };

  // Canvas pixels per screen pixel. Every point and the pen width go through
  // this, so the ink lands under the finger even if the box was resized.
  const scale = () => {
    const c = canvasRef.current; const r = c.getBoundingClientRect();
    return { r, kx: c.width / (r.width || 1), ky: c.height / (r.height || 1) };
  };
  const point = (clientX, clientY) => {
    const { r, kx, ky } = scale();
    return { x: (clientX - r.left) * kx, y: (clientY - r.top) * ky, k: kx };
  };
  const pen = (ctx, k) => { ctx.lineWidth = 2.6 * k; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a'; ctx.fillStyle = '#1a1a1a'; };

  const begin = (clientX, clientY) => {
    drawing.current = true;
    const p = point(clientX, clientY);
    last.current = p;
    // A tap leaves a dot so the pen feels live; only a stroke counts as signed.
    const ctx = canvasRef.current.getContext('2d'); pen(ctx, p.k);
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.3 * p.k, 0, Math.PI * 2); ctx.fill();
  };
  const extend = (clientX, clientY) => {
    if (!drawing.current || !last.current) return;
    const p = point(clientX, clientY);
    const ctx = canvasRef.current.getContext('2d'); pen(ctx, p.k);
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
    if (!inked.current) mark(true);
  };
  const finish = () => { drawing.current = false; last.current = null; };

  // Size the canvas to the box on screen (sharp on retina), once it has a
  // width. Only resized while empty: resizing a canvas wipes it, and the
  // phone's address bar hiding fires resize events mid-signature.
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const fit = () => {
      if (inked.current) return;
      const r = c.getBoundingClientRect(); if (!r.width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    };
    fit();
    window.addEventListener('resize', fit);
    // React registers touch handlers as passive, which cannot stop the page
    // scrolling. These can. touch-action:none on the canvas covers the rest.
    const hold = (e) => { if (e.cancelable) e.preventDefault(); };
    c.addEventListener('touchstart', hold, { passive: false });
    c.addEventListener('touchmove', hold, { passive: false });
    return () => {
      window.removeEventListener('resize', fit);
      c.removeEventListener('touchstart', hold);
      c.removeEventListener('touchmove', hold);
    };
  }, []);

  const clear = () => {
    const c = canvasRef.current; if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    finish(); mark(false);
  };

  // Fallback: the typed name, written in a handwriting face. An electronic
  // signature is the signer's intent, not the pen stroke.
  const signWithName = (name) => {
    const c = canvasRef.current; const n = (name || '').trim(); if (!c || !n) return false;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    let size = Math.round(c.height * 0.42);
    const face = (s) => `italic ${s}px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive`;
    ctx.font = face(size);
    while (size > 12 && ctx.measureText(n).width > c.width * 0.9) { size -= 2; ctx.font = face(size); }
    ctx.fillStyle = '#1a1a1a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(n, c.width / 2, c.height / 2);
    mark(true);
    return true;
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => !inked.current,
    toDataURL: () => canvasRef.current?.toDataURL('image/png') || '',
    clear,
    signWithName,
  }));

  const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
  const handlers = hasPointer ? {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
      begin(e.clientX, e.clientY);
    },
    onPointerMove: (e) => {
      if (!drawing.current) return;
      // Fast strokes on a phone arrive batched; draw every sample, not just the last.
      const evs = e.nativeEvent.getCoalescedEvents?.() || [];
      if (evs.length) evs.forEach(ev => extend(ev.clientX, ev.clientY));
      else extend(e.clientX, e.clientY);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
  } : {
    // Browsers from before pointer events (iOS 12 and older).
    onTouchStart: (e) => { const t = e.touches[0]; if (t) begin(t.clientX, t.clientY); },
    onTouchMove: (e) => { const t = e.touches[0]; if (t) extend(t.clientX, t.clientY); },
    onTouchEnd: finish,
    onMouseDown: (e) => begin(e.clientX, e.clientY),
    onMouseMove: (e) => extend(e.clientX, e.clientY),
    onMouseUp: finish,
    onMouseLeave: finish,
  };

  return (
    <div className={`relative border rounded-lg bg-white ${hasInk ? 'border-slate-400' : 'border-slate-300'}`}>
      <canvas ref={canvasRef} width={620} height={220} {...handlers}
        aria-label="Signature box. Draw your signature with your finger or mouse."
        className="block w-full h-40 sm:h-44 touch-none select-none cursor-crosshair rounded-lg"
        style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }} />
      {!hasInk && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-slate-300 text-sm">
          Sign here with your finger
        </div>
      )}
      <div className="pointer-events-none absolute left-4 right-4 bottom-8 border-b border-dashed border-slate-200" />
    </div>
  );
});

export default SignaturePad;
