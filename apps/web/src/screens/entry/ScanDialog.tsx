import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, RotateCcw, Save } from 'lucide-react';
import { JOURNAL_EXTRA_MESSAGES as X, SCAN_FORMATS, scanAttachmentFileName, type ScanFormat } from '@shmi/core';
import { useDialogs } from '../../components/dialogs.tsx';
import { Button, Dialog, Field, Select } from '../../components/ui.tsx';

type CameraState = 'starting' | 'on' | 'none';

/** getUserMedia is missing outside secure contexts and in old browsers (the DOM types say it is always there). */
const hasCamera = () => typeof (navigator.mediaDevices as MediaDevices | undefined)?.getUserMedia === 'function';

/** Draws an image source on a white canvas (a transparent PNG becomes a white page in JPEG). */
function toCanvas(src: CanvasImageSource, width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, width, height);
  g.drawImage(src, 0, 0, width, height);
  return c;
}

/**
 * Сканиране на документ (02a 4.6, strScanDocument). Delta scans through TWAIN
 * with the JPEG encoder; the browser's scanner is the camera: a live preview
 * (getUserMedia, rear camera preferred) with a capture button, or, without a
 * camera, a photo from the device (`<input accept="image/*" capture>`, which
 * opens the camera on phones). The page is stored as one JPEG (default) or
 * PNG attachment through the attachment upload.
 */
export function ScanDialog({ onSave, onClose }: { onSave: (file: File) => Promise<boolean>; onClose: () => void }) {
  const dialogs = useDialogs();
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraState>(() => (hasCamera() ? 'starting' : 'none'));
  const [shot, setShot] = useState<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState('');
  const [format, setFormat] = useState<ScanFormat>('jpeg');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasCamera()) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((x) => {
        if (cancelled) return x.getTracks().forEach((t) => t.stop());
        s = x;
        setStream(x);
        setCamera('on');
      })
      .catch(() => !cancelled && setCamera('none'));
    return () => {
      cancelled = true;
      s?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
  }, [stream]);

  const take = (c: HTMLCanvasElement) => {
    setShot(c);
    setPreview(c.toDataURL('image/jpeg', 0.8));
  };

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    take(toCanvas(v, v.videoWidth, v.videoHeight));
  };

  const fromFile = async (f: File) => {
    try {
      const bmp = await createImageBitmap(f);
      take(toCanvas(bmp, bmp.width, bmp.height));
      bmp.close();
    } catch {
      await dialogs.alert(X.strIOErrorReadingFile, X.strScanDocument);
    }
  };

  const save = async () => {
    if (!shot) return;
    const { mime } = SCAN_FORMATS[format];
    setBusy(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => shot.toBlob(resolve, mime, 0.9));
      if (!blob) return void (await dialogs.alert(X.strIOErrorReadingFile, X.strScanDocument));
      if (await onSave(new File([blob], scanAttachmentFileName(new Date(), format), { type: mime }))) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={X.strScanDocument}
      width={700}
      onClose={onClose}
      footer={
        <>
          {shot ? (
            <>
              <Button icon={<RotateCcw className="size-3.5" />} disabled={busy} onClick={() => setShot(null)}>
                Ново сканиране
              </Button>
              <Button variant="primary" icon={<Save className="size-3.5" />} disabled={busy} onClick={save} data-testid="scan-save">
                Запис
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<Camera className="size-3.5" />} disabled={camera !== 'on'} onClick={capture} data-testid="scan-capture">
              Заснемане
            </Button>
          )}
          <Button onClick={onClose}>Отказ</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="scan-dialog">
        <div className="relative flex h-[380px] items-center justify-center overflow-hidden rounded-sm border border-slate-300 bg-slate-800">
          {camera === 'on' && <video ref={video} muted playsInline className={shot ? 'hidden' : 'max-h-full max-w-full'} data-testid="scan-video" aria-label="Изглед от камерата" />}
          {shot && <img src={preview} alt="Сканиран документ" className="max-h-full max-w-full bg-white" data-testid="scan-preview" />}
          {!shot && camera !== 'on' && (
            <div className="px-6 text-center text-slate-200">
              {camera === 'starting' ? 'Свързване с камерата...' : 'Няма достъпна камера. Изберете снимка на документа от устройството.'}
            </div>
          )}
        </div>
        <div className="flex items-end gap-3">
          <Field label="Формат" className="w-44">
            <Select value={format} onChange={(e) => setFormat(e.target.value as ScanFormat)} aria-label="Формат">
              <option value="jpeg">JPEG</option>
              <option value="png">PNG</option>
            </Select>
          </Field>
          <input ref={fileInput} type="file" accept="image/*" capture="environment" className="hidden" data-testid="scan-file" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void fromFile(f);
          }} />
          <Button icon={<ImagePlus className="size-3.5" />} disabled={busy} onClick={() => fileInput.current?.click()}>
            Снимка от устройството...
          </Button>
          {shot && <span className="ml-auto text-[12px] text-slate-500" data-testid="scan-size">{shot.width} x {shot.height}</span>}
        </div>
      </div>
    </Dialog>
  );
}
