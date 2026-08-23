import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import Button from './Button';
import '../styles/ImageCropModal.css';

const STAGE_WIDTH = 400;
const STAGE_HEIGHT = 280;
const CROP_DIAMETER = 220;
const OUTPUT_SIZE = 512;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

interface ImageCropModalProps {
  data: ArrayBuffer;
  mimeType: string;
  onCancel: () => void;
  onApply: (result: { data: ArrayBuffer; mimeType: string }) => void;
}

interface Offset {
  x: number;
  y: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Discord-style "escolher o foco em círculo" — zoom via slider, arraste pra reposicionar,
 * "Redefinir" volta ao centro/zoom 1. Aplicar corta exatamente a região visível dentro do
 * círculo (independente do aspect ratio da imagem original) num PNG quadrado com máscara
 * circular (cantos transparentes), pronto pro mesmo cache local + distribuição P2P de sempre.
 */
export default function ImageCropModal({ data, mimeType, onCancel, onApply }: ImageCropModalProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isApplying, setIsApplying] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<{ startMouseX: number; startMouseY: number; startOffset: Offset } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data, mimeType]);

  // Base scale covers the whole stage rectangle (not just the crop circle) at zoom 1 — just
  // the starting framing, panning below is free to move past that (see boundsFor).
  function baseScaleFor(size: { width: number; height: number } | null): number {
    if (!size) return 1;
    return Math.max(STAGE_WIDTH / size.width, STAGE_HEIGHT / size.height);
  }

  const circleLeft = (STAGE_WIDTH - CROP_DIAMETER) / 2;
  const circleRight = (STAGE_WIDTH + CROP_DIAMETER) / 2;
  const circleTop = (STAGE_HEIGHT - CROP_DIAMETER) / 2;
  const circleBottom = (STAGE_HEIGHT + CROP_DIAMETER) / 2;

  // Only requires the image to still fully cover the crop *circle*, not the whole stage
  // rectangle — the dimmed area outside the circle is free to show empty stage background, so
  // the image can be dragged well past its own edges to bring any corner into the circle.
  function boundsFor(zoomValue: number, size: { width: number; height: number } | null = naturalSize): Bounds {
    const scale = baseScaleFor(size) * zoomValue;
    const width = (size?.width ?? 0) * scale;
    const height = (size?.height ?? 0) * scale;
    return { minX: circleRight - width, maxX: circleLeft, minY: circleBottom - height, maxY: circleTop, width, height };
  }

  function clamp(value: Offset, bounds: Bounds): Offset {
    return {
      x: Math.min(bounds.maxX, Math.max(bounds.minX, value.x)),
      y: Math.min(bounds.maxY, Math.max(bounds.minY, value.y))
    };
  }

  function centeredOffsetFor(
    zoomValue: number,
    size: { width: number; height: number } | null = naturalSize
  ): Offset {
    const bounds = boundsFor(zoomValue, size);
    return { x: (STAGE_WIDTH - bounds.width) / 2, y: (STAGE_HEIGHT - bounds.height) / 2 };
  }

  const baseScale = baseScaleFor(naturalSize);
  const bounds = boundsFor(zoom);
  const scale = baseScale * zoom;

  function handleImageLoad(): void {
    const img = imageRef.current;
    if (!img) return;
    // Reads img.naturalWidth/Height directly rather than the naturalSize state var — setState
    // doesn't apply until the next render, so centeredOffsetFor(ZOOM_MIN) right after would
    // otherwise still see the previous (null) state and center against a 0×0 size, landing the
    // image well outside the circle the first time a picture loads.
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setNaturalSize(size);
    setZoom(ZOOM_MIN);
    setOffset(centeredOffsetFor(ZOOM_MIN, size));
  }

  function handleDragStart(event: ReactMouseEvent): void {
    dragStateRef.current = { startMouseX: event.clientX, startMouseY: event.clientY, startOffset: offset };
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
  }

  function handleDragMove(event: MouseEvent): void {
    const drag = dragStateRef.current;
    if (!drag) return;
    setOffset(
      clamp(
        {
          x: drag.startOffset.x + (event.clientX - drag.startMouseX),
          y: drag.startOffset.y + (event.clientY - drag.startMouseY)
        },
        bounds
      )
    );
  }

  function handleDragEnd(): void {
    dragStateRef.current = null;
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup', handleDragEnd);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only, not a live subscription
  }, []);

  // Keeps whatever's currently at the crop circle's center anchored there as zoom changes —
  // without this, the offset (top-left based) stays numerically fixed while the image grows,
  // so the visible region silently drifts toward the top-left corner as you zoom in.
  function handleZoomChange(newZoom: number): void {
    if (!naturalSize) {
      setZoom(newZoom);
      return;
    }
    const naturalCenterX = (STAGE_WIDTH / 2 - offset.x) / scale;
    const naturalCenterY = (STAGE_HEIGHT / 2 - offset.y) / scale;
    const newScale = baseScale * newZoom;
    const newBounds = boundsFor(newZoom);
    setZoom(newZoom);
    setOffset(
      clamp(
        { x: STAGE_WIDTH / 2 - naturalCenterX * newScale, y: STAGE_HEIGHT / 2 - naturalCenterY * newScale },
        newBounds
      )
    );
  }

  function handleReset(): void {
    setZoom(ZOOM_MIN);
    setOffset(centeredOffsetFor(ZOOM_MIN));
  }

  async function handleApply(): Promise<void> {
    const img = imageRef.current;
    if (!img || !naturalSize) return;
    setIsApplying(true);
    try {
      // Stage-space crop circle -> natural-image-space square region, via the same offset/scale
      // used to render the preview (uniform scale, so the mapped region is guaranteed square).
      const radius = CROP_DIAMETER / 2 / scale;
      const centerX = (STAGE_WIDTH / 2 - offset.x) / scale;
      const centerY = (STAGE_HEIGHT / 2 - offset.y) / scale;

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.beginPath();
      ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        img,
        centerX - radius,
        centerY - radius,
        radius * 2,
        radius * 2,
        0,
        0,
        OUTPUT_SIZE,
        OUTPUT_SIZE
      );

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      onApply({ data: await blob.arrayBuffer(), mimeType: 'image/png' });
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div
      className="image-crop-modal__backdrop"
      onClick={(event) => {
        // Nested inside another modal's own backdrop (ProfilePage/ServerActionsModal) —
        // stop here so dismissing this one doesn't also bubble up and close that one.
        event.stopPropagation();
        onCancel();
      }}
    >
      <div className="image-crop-modal" onClick={(event) => event.stopPropagation()}>
        <header className="image-crop-modal__header">
          <h2>Editar imagem</h2>
          <button className="image-crop-modal__close" onClick={onCancel} title="Fechar">
            ×
          </button>
        </header>

        <div className="image-crop-modal__stage" onMouseDown={handleDragStart}>
          {imageUrl && (
            <img
              ref={imageRef}
              src={imageUrl}
              onLoad={handleImageLoad}
              alt=""
              draggable={false}
              className="image-crop-modal__image"
              style={{ left: offset.x, top: offset.y, width: bounds.width, height: bounds.height }}
            />
          )}
          <div className="image-crop-modal__ring" style={{ width: CROP_DIAMETER, height: CROP_DIAMETER }} />
        </div>

        <div className="image-crop-modal__zoom-row">
          <ImageIcon size={14} className="image-crop-modal__zoom-icon" />
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.01}
            value={zoom}
            onChange={(event) => handleZoomChange(Number(event.target.value))}
            className="image-crop-modal__zoom-slider"
          />
          <ImageIcon size={20} className="image-crop-modal__zoom-icon" />
        </div>

        <div className="image-crop-modal__footer">
          <button className="image-crop-modal__reset" onClick={handleReset}>
            Redefinir
          </button>
          <div className="image-crop-modal__footer-actions">
            <Button variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
            <Button onClick={handleApply} disabled={!naturalSize || isApplying}>
              {isApplying ? 'Aplicando…' : 'Aplicar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
