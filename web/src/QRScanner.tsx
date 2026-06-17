import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface QRScannerProps {
  onScan: (url: string) => void;
  onClose: () => void;
}

type CameraError = {
  title: string;
  message: string;
  showManual: boolean;
};

function classifyCameraError(err: unknown): CameraError {
  const raw = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  if (raw.includes('permission') || raw.includes('notallowed') || raw.includes('denied')) {
    return {
      title: 'Camera permission denied',
      message:
        'The camera permission was blocked. Enable camera access for this app in your device settings, then try again.',
      showManual: true,
    };
  }
  if (raw.includes('notfound') || raw.includes('no camera') || raw.includes('requested device not found')) {
    return {
      title: 'No camera available',
      message:
        'No camera was found on this device. You can paste the QR code URL below to connect manually.',
      showManual: true,
    };
  }
  if (raw.includes('secure') || raw.includes('https')) {
    return {
      title: 'Camera requires a secure connection',
      message:
        'Camera access requires HTTPS or localhost. Open this page over HTTPS, then try again.',
      showManual: true,
    };
  }
  if (raw.includes('in use') || raw.includes('busy') || raw.includes('notreadable')) {
    return {
      title: 'Camera is busy',
      message:
        'Another app is using the camera. Close it and try again, or connect manually below.',
      showManual: true,
    };
  }
  return {
    title: 'Camera unavailable',
    message: `Failed to start the camera: ${(err as { message?: string })?.message || String(err)}. You can paste the QR code URL below to connect manually.`,
    showManual: true,
  };
}

export default function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [error, setError] = useState<CameraError | null>(null);
  const [manualValue, setManualValue] = useState('');
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      // Best-effort preflight: query the camera permission so we can show a
      // tailored message before the scanner hits getUserMedia.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const permissions: any = (navigator as any)?.permissions;
        if (permissions?.query) {
          const status = await permissions.query({ name: 'camera' as PermissionName });
          if (status.state === 'denied') {
            if (cancelled) return;
            setError({
              title: 'Camera permission denied',
              message:
                'Camera access is blocked for this site. Enable it in your browser or device settings, then reload.',
              showManual: true,
            });
            return;
          }
        }
      } catch {
        // Permissions API not supported or 'camera' not queryable — fall through
        // and let the scanner attempt to start; its own error path will surface
        // a classified message.
      }

      if (cancelled) return;

      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            scanner
              .stop()
              .then(() => onScan(decodedText))
              .catch((stopErr) => {
                console.error('Failed to stop scanner', stopErr);
                onScan(decodedText);
              });
          },
          () => {
            // Ignored — fires on every frame when no QR code is present.
          }
        );
      } catch (err) {
        console.error('QR scanner start failed', err);
        if (cancelled) return;
        setError(classifyCameraError(err));
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch((err) => {
          // Scanner likely already torn down by the success/failure path.
          // Swallow the "scanner is not running" error; surface anything else.
          if (!/not.*running|not.*started/i.test(String((err as { message?: string })?.message ?? err))) {
            console.error('Failed to stop scanner', err);
          }
        });
      }
    };
  }, [onScan]);

  const submitManual = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    onScan(trimmed);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--bg-main)',
          padding: '20px',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '400px',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: '15px' }}>Scan QR Code</h3>
        {error ? (
          <div style={{ marginBottom: '15px' }}>
            <p style={{ color: 'red', margin: '0 0 8px 0', fontWeight: 600 }}>{error.title}</p>
            <p style={{ color: 'var(--text-muted)', margin: '0 0 12px 0', fontSize: '0.9rem' }}>
              {error.message}
            </p>
            {error.showManual && (
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    color: 'var(--text-muted)',
                    marginBottom: '5px',
                  }}
                >
                  Paste QR code URL
                </label>
                <input
                  type="text"
                  value={manualValue}
                  onChange={(e) => setManualValue(e.target.value)}
                  placeholder="http://server:port/?token=…"
                  style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitManual();
                  }}
                />
                <button
                  className="btn primary-btn"
                  onClick={submitManual}
                  disabled={!manualValue.trim()}
                  style={{ width: '100%', marginTop: '10px' }}
                >
                  Connect
                </button>
              </div>
            )}
          </div>
        ) : null}
        <div
          id="qr-reader"
          style={{ width: '100%', minHeight: error ? '0' : '300px', display: error ? 'none' : 'block' }}
        ></div>
        <button className="btn" onClick={onClose} style={{ width: '100%', marginTop: '15px' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
