// An inline image in the conversation: a constrained, clickable thumbnail
// that opens a lightbox with Copy-image and Save-to-disk actions. Used both
// by RichText (markdown ![](...) the model emits) and by the assistant
// image-content-block renderer (tool-pushed images like AppScreenshot).
//
// Copy/save are done in the MAIN process (electron clipboard / dialog / net),
// which sidesteps browser clipboard permissions AND CORS for remote URLs.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  src: string; // http(s):// , file:// , or data: URL
  alt?: string;
}

export function InlineImage({ src, alt }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const doCopy = async () => {
    setBusy('copy');
    try {
      const r = await window.api.image.copy(src);
      setToast(r?.ok ? 'Copied to clipboard' : `Copy failed: ${r?.error ?? 'unknown'}`);
    } catch (e: any) {
      setToast(`Copy failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const doSave = async () => {
    setBusy('save');
    try {
      const r = await window.api.image.save(src);
      if (r?.ok && r.path) setToast(`Saved to ${r.path}`);
      else if (r?.canceled) setToast(null);
      else setToast(`Save failed: ${r?.error ?? 'unknown'}`);
    } catch (e: any) {
      setToast(`Save failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  if (broken) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-text-muted border border-border rounded px-1.5 py-0.5">
        🖼️ {alt || 'image'} (failed to load)
      </span>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        onClick={() => setOpen(true)}
        onError={() => setBroken(true)}
        className="max-h-64 max-w-full rounded-md border border-border object-contain bg-bg my-1 cursor-zoom-in hover:border-border-strong transition-colors"
        title={alt ? `${alt} — click to view, copy, or save` : 'Click to view, copy, or save'}
      />
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/80 p-6"
            onClick={() => setOpen(false)}
          >
            <div
              className="relative max-h-[80vh] max-w-[90vw] flex flex-col items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={src}
                alt={alt ?? ''}
                className="max-h-[80vh] max-w-[90vw] object-contain rounded-md shadow-2xl"
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={doCopy}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-[12px] rounded border border-border bg-bg-elevated text-text hover:border-border-strong disabled:opacity-50"
                >
                  {busy === 'copy' ? 'Copying…' : 'Copy image'}
                </button>
                <button
                  onClick={doSave}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-[12px] rounded border border-border bg-bg-elevated text-text hover:border-border-strong disabled:opacity-50"
                >
                  {busy === 'save' ? 'Saving…' : 'Save as…'}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="px-3 py-1.5 text-[12px] rounded border border-border text-text-muted hover:text-text"
                >
                  Close
                </button>
              </div>
              {toast && (
                <div className="mt-2 text-[11px] text-text-muted bg-bg-elevated border border-border rounded px-2 py-1">
                  {toast}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
