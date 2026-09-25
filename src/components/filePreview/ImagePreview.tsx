import { useRef, useState } from "react";

import { container } from "../../services/container";
import type { FilePreviewDoc } from "../../services/filePreviewService";

/**
 * An image in a scrollable pane. It is drawn with `<img>` from a `data:` address: an SVG shown that way runs no
 * script and loads nothing external. Fit shrinks it into the pane, Actual size is 1:1, Zoom multiplies its own size;
 * a zoomed image is panned by dragging (or scrolling).
 */
export function ImagePreview({
  doc,
  dataUrl,
  notice,
}: {
  doc: FilePreviewDoc;
  dataUrl: string;
  notice: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const pane = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const size = doc.dimensions;
  const style =
    doc.zoomMode === "fit"
      ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" as const }
      : doc.zoomMode === "actual" || size === null
        ? { maxWidth: "none" }
        : { maxWidth: "none", width: `${String(Math.round(size.width * doc.zoom))}px` };

  return (
    <div className="file-preview__image-wrap">
      {notice === null ? null : (
        <p className="file-preview__notice" role="status">
          {notice}
        </p>
      )}
      {failed ? (
        <p className="file-preview__error" role="alert">
          This image couldn't be decoded. It may be damaged or use an unsupported format.
        </p>
      ) : (
        <div
          ref={pane}
          className={
            doc.zoomMode === "fit"
              ? "file-preview__image"
              : "file-preview__image file-preview__image--pan"
          }
          onPointerDown={(event) => {
            if (doc.zoomMode === "fit" || !pane.current) return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: pane.current.scrollLeft,
              top: pane.current.scrollTop,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || !pane.current) return;
            pane.current.scrollLeft = start.left - (event.clientX - start.x);
            pane.current.scrollTop = start.top - (event.clientY - start.y);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <img
            src={dataUrl}
            alt={doc.name}
            draggable={false}
            style={style}
            onLoad={(event) => {
              const image = event.currentTarget;
              container.filePreviews.setDimensions(doc.id, image.naturalWidth, image.naturalHeight);
            }}
            onError={() => {
              setFailed(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
