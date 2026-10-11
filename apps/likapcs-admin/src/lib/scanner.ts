/**
 * Page-wide barcode scanner capture.
 *
 * USB scanners are keyboards: they type the code in a few milliseconds and finish with Enter.
 * The old POS only listened inside the search field, so a scan was lost whenever the focus was
 * somewhere else — on the product tile that was just tapped, on a quantity field, or nowhere at
 * all after a dialog closed (the browser drops the focus to <body> when the focused button
 * unmounts). Worse, Enter on a focused tile re-added that tile's product instead of the scanned
 * one.
 *
 * This hook watches every keydown on the document (capture phase, so it runs before React and
 * before any dialog), recognises scanner bursts by timing, removes the burst from whatever input
 * happened to receive it and hands the code to the page. A printable key pressed while nothing
 * editable is focused is routed into the preferred input first, so even a slow scanner (or a
 * human typing a code) lands in the search field rather than nowhere.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { ScanBuffer } from './cart';

export interface BarcodeScannerOptions {
  /** Receives every detected scan. Dialog handling is the caller's business. */
  onScan: (code: string) => void;
  /** Field that should receive stray printable keys (the POS search box). */
  focusTarget?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
  /** Max gap between two scanner keys; the average must stay below it (default 75 ms). */
  maxGapMs?: number;
  minLength?: number;
}

export function isEditableElement(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range'].includes(el.type);
  }
  return false;
}

/** The input value without the scanned code the scanner just typed into it (if it is there). */
export function stripScannedCode(value: string, code: string): string {
  if (!code) return value;
  return value.endsWith(code) ? value.slice(0, value.length - code.length) : value;
}

/**
 * Sets a controlled React input's value from outside React and notifies React about it (the
 * prototype setter bypasses React's value tracker, so the synthetic `input` event is not deduped).
 */
export function setNativeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function useBarcodeScanner({
  onScan,
  focusTarget,
  enabled = true,
  maxGapMs = 75,
  minLength = 4,
}: BarcodeScannerOptions): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const buffer = new ScanBuffer(maxGapMs, minLength);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      const editable = isEditableElement(target);
      if (e.key.length === 1) {
        buffer.push(e.key, e.timeStamp);
        // Nothing editable has the focus (a tile, a button, <body> after a dialog closed): send
        // the character to the search field so it is not lost. Focusing during keydown works
        // because the character is inserted afterwards, into whatever is focused by then.
        const field = focusTarget?.current;
        if (!editable && field && !field.disabled && !target?.closest('[role="dialog"]')) {
          field.focus();
        }
        return;
      }
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      const code = buffer.flush(e.timeStamp);
      if (!code) return;
      // A scanner burst just ended: keep it away from whatever had the focus (a button would be
      // "clicked" by the Enter, a quantity field would keep the digits) and hand the code over.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const cleaned = stripScannedCode(target.value, code);
        if (cleaned !== target.value) setNativeInputValue(target, cleaned);
      }
      onScanRef.current(code);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [enabled, focusTarget, maxGapMs, minLength]);
}
