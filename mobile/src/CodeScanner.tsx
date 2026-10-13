// Reads a QR code (or a licence disc) with the camera. In the phone app: the phone's own reader. In
// a phone's or computer's browser: the browser's reader where it has one (Chrome on Android), and
// otherwise the ZXing reader that comes with the app (iPhones in Safari), loaded from the app's own
// server (zxing_reader.wasm next to the page), never from the internet.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { BarcodeDetector as ZXingDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import { Button, st } from './ui.tsx';

const NATIVE_TYPES: BarcodeType[] = ['qr', 'pdf417', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'aztec'];

export function CodeScanner({ onCode, height = 280, hint, torch }: { onCode: (code: string) => void; height?: number; hint?: string; torch?: boolean }) {
  if (Platform.OS === 'web') return <WebScanner onCode={onCode} height={height} hint={hint} />;
  return <NativeScanner onCode={onCode} height={height} hint={hint} torch={torch} />;
}

function NativeScanner({ onCode, height, hint, torch }: { onCode: (c: string) => void; height: number; hint?: string; torch?: boolean }) {
  const [perm, ask] = useCameraPermissions();
  const seen = useRef(false);
  if (!perm?.granted) return <Button label="Allow the camera to scan" onPress={ask} />;
  return (
    <View style={{ height, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back" enableTorch={!!torch} barcodeScannerSettings={{ barcodeTypes: NATIVE_TYPES }}
        onBarcodeScanned={r => { if (r.data && !seen.current) { seen.current = true; onCode(r.data); } }} />
      {hint ? <Text style={{ position: 'absolute', bottom: 10, left: 0, right: 0, textAlign: 'center', color: '#fff' }}>{hint}</Text> : null}
    </View>
  );
}

const WEB_FORMATS = ['qr_code', 'pdf417', 'code_128', 'data_matrix'];
let zxingReady = false;
/** The ZXing reader, with its program file from next to the page. */
function zxing() {
  if (!zxingReady) {
    zxingReady = true;
    prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? new URL('zxing_reader.wasm', document.baseURI).href : prefix + path) } });
  }
  return new ZXingDetector({ formats: WEB_FORMATS as never });
}

function WebScanner({ onCode, height, hint }: { onCode: (c: string) => void; height: number; hint?: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<string>('');
  useEffect(() => {
    let stream: MediaStream | null = null, timer: ReturnType<typeof setInterval> | null = null, done = false;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) { setErr('This browser cannot use the camera here: type the code instead.'); return; }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        const v = video.current;
        if (!v || done) return;
        v.srcObject = stream; v.setAttribute('playsinline', 'true'); v.muted = true;
        await v.play().catch(() => {});
        // The browser's own reader when it has one; otherwise the ZXing reader that comes with the app.
        const BD = (globalThis as { BarcodeDetector?: new (o: object) => { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        let reader: { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> } | null = null;
        try { if (BD) reader = new BD({ formats: WEB_FORMATS }); } catch { reader = null; }
        if (!reader) reader = zxing() as never;
        setMode(BD ? 'browser' : 'app');
        let busy = false;
        timer = setInterval(async () => {
          if (done || busy || !v.videoWidth) return;
          busy = true;
          try {
            const w = Math.min(1280, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
            canvas.width = w; canvas.height = h;
            g!.drawImage(v, 0, 0, w, h);
            const r = await reader!.detect(canvas);
            if (r[0]?.rawValue && !done) { done = true; onCode(r[0].rawValue); }
          } catch { /* next frame */ } finally { busy = false; }
        }, 300);
      } catch {
        setErr('The camera is not allowed or not there: allow it in the browser, or type the code.');
      }
    })();
    return () => { done = true; if (timer) clearInterval(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  if (err) return <Text style={st.small}>{err}</Text>;
  return (
    <View style={{ height, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' }}>
      {React.createElement('video', { ref: video, playsInline: true, muted: true, style: { width: '100%', height: '100%', objectFit: 'cover' }, 'aria-label': 'Camera' })}
      <View pointerEvents="none" style={{ position: 'absolute', alignSelf: 'center', top: '15%', bottom: '15%', aspectRatio: 1, borderWidth: 2, borderColor: '#ffffffaa', borderRadius: 8 }} />
      <Text style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', color: '#fff' }}>{hint ?? 'Hold the QR code inside the square'}</Text>
    </View>
  );
}
