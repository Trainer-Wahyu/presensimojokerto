import { APP_CONFIG } from './supabase-client.js';

// Indeks landmark kelopak mata MediaPipe Face Mesh (468 titik)
const LEFT_EYE_IDX = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE_IDX = [362, 385, 387, 263, 373, 380];

function distance2D(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

/**
 * Menghitung Eye Aspect Ratio (EAR) untuk mendeteksi mata terbuka vs tertutup
 */
function calculateEAR(landmarks, indices) {
  const v1 = distance2D(landmarks[indices[1]], landmarks[indices[5]]);
  const v2 = distance2D(landmarks[indices[2]], landmarks[indices[4]]);
  const h = distance2D(landmarks[indices[0]], landmarks[indices[3]]);
  if (h === 0) return 0;
  return (v1 + v2) / (2.0 * h);
}

/**
 * Memastikan tidak ada kamera virtual / aplikasi injeksi video yang digunakan
 */
async function ensurePhysicalCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Peramban tidak mendukung akses kamera.');
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const virtualPattern = /obs|virtual|manycam|fake|droidcam|iriun|epoccam|splitcam/i;

  const hasVirtualInput = devices.some(
    (device) => device.kind === 'videoinput' && virtualPattern.test(device.label)
  );

  if (hasVirtualInput) {
    throw new Error('Kamera virtual terdeteksi. Gunakan kamera depan asli perangkat.');
  }
}

/**
 * Mengompresi elemen <canvas> menjadi Blob JPEG di bawah target batas KB (~200 KB)
 */
async function compressCanvasToTargetKB(canvas, maxKB = 210) {
  let quality = 0.78;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  while (blob && blob.size / 1024 > maxKB && quality > 0.35) {
    quality = Number((quality - 0.07).toFixed(2));
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  return blob;
}

/**
 * Mengambil frame dari elemen video, membalik horizontal (mirror), dan mengompresnya
 */
async function captureMirroredPhotoBlob(videoEl, maxKB) {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 960;

  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);

  // Hitung crop proporsional 3:4 agar wajah tidak gepeng pada berbagai rasio kamera HP
  const videoRatio = videoEl.videoWidth / videoEl.videoHeight;
  const targetRatio = canvas.width / canvas.height;
  let sx = 0;
  let sy = 0;
  let sWidth = videoEl.videoWidth;
  let sHeight = videoEl.videoHeight;

  if (videoRatio > targetRatio) {
    sWidth = videoEl.videoHeight * targetRatio;
    sx = (videoEl.videoWidth - sWidth) / 2;
  } else {
    sHeight = videoEl.videoWidth / targetRatio;
    sy = (videoEl.videoHeight - sHeight) / 2;
  }

  ctx.drawImage(videoEl, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);

  return compressCanvasToTargetKB(canvas, maxKB);
}

/**
 * Menjalankan kamera depan, memantau Liveness Detection (kedipan mata),
 * dan otomatis memicu pengambilan foto setelah wajah manusia terverifikasi.
 *
 * @returns {{ stop: () => void }} Kontroler untuk menghentikan kamera secara manual
 */
export async function startLivenessCapture(options = {}) {
  const {
    videoId = 'camera-video',
    ovalId = 'face-oval',
    instructionId = 'liveness-instruction',
    maxPhotoKB = APP_CONFIG.TARGET_PHOTO_MAX_KB,
    onCaptured
  } = options;

  const videoEl = document.getElementById(videoId);
  const ovalEl = document.getElementById(ovalId);
  const instructionEl = document.getElementById(instructionId);

  if (!videoEl) {
    throw new Error(`Elemen video #${videoId} tidak ditemukan.`);
  }
  if (typeof window.FaceMesh !== 'function') {
    throw new Error('Pustaka MediaPipe FaceMesh belum termuat.');
  }

  await ensurePhysicalCamera();

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 720 },
      height: { ideal: 960 }
    },
    audio: false
  });

  videoEl.srcObject = stream;
  await videoEl.play();

  let isRunning = true;
  let isCaptured = false;
  let eyeClosedFrames = 0;
  let hasBlinked = false;
  let rafId = null;

  const updateUI = (text, isReady = false) => {
    if (instructionEl) instructionEl.textContent = text;
    if (ovalEl) {
      ovalEl.classList.toggle('ready', isReady);
    }
  };

  const cleanupResources = () => {
    isRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    stream.getTracks().forEach((track) => track.stop());
    videoEl.srcObject = null;
  };

  const faceMesh = new window.FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
  });

  faceMesh.onResults(async (results) => {
    if (!isRunning || isCaptured) return;

    const faces = results.multiFaceLandmarks;
    if (!faces || faces.length === 0) {
      hasBlinked = false;
      eyeClosedFrames = 0;
      updateUI('Wajah tidak terdeteksi. Arahkan wajah ke bingkai oval.', false);
      return;
    }

    // Tolak jika terdeteksi lebih dari 1 wajah di bingkai (mencegah kecurangan berjamaah)
    if (faces.length > 1) {
      hasBlinked = false;
      eyeClosedFrames = 0;
      updateUI('Terdeteksi lebih dari satu wajah. Pastikan hanya Anda di depan kamera.', false);
      return;
    }

    const lm = faces[0];
    const noseTip = lm[1];
    const faceWidth = distance2D(lm[234], lm[454]);

    // Validasi posisi wajah berada di tengah oval & jarak wajah proporsional
    const isCentered =
      noseTip.x > 0.34 && noseTip.x < 0.66 && noseTip.y > 0.3 && noseTip.y < 0.7;
    const isProperDistance = faceWidth > 0.27 && faceWidth < 0.74;

    if (!isCentered || !isProperDistance) {
      hasBlinked = false;
      eyeClosedFrames = 0;
      updateUI('Posisikan wajah tepat di tengah bingkai oval...', false);
      return;
    }

    const avgEAR = (calculateEAR(lm, LEFT_EYE_IDX) + calculateEAR(lm, RIGHT_EYE_IDX)) / 2;

    // Tahap 1: Mata terdeteksi menutup (ambang batas EAR < 0.19)
    if (avgEAR < 0.19) {
      eyeClosedFrames += 1;
      if (eyeClosedFrames >= 1) {
        hasBlinked = true;
        updateUI('Kedipan terdeteksi! Buka mata kembali...', true);
      }
      return;
    }

    // Tahap 2: Mata kembali terbuka penuh (EAR > 0.23) setelah kedip -> Auto-Capture
    if (hasBlinked && avgEAR > 0.23) {
      isCaptured = true;
      updateUI('Wajah manusia terverifikasi! Mengambil & mengompres foto...', true);

      try {
        const photoBlob = await captureMirroredPhotoBlob(videoEl, maxPhotoKB);
        cleanupResources();
        await faceMesh.close();

        if (typeof onCaptured === 'function') {
          onCaptured(photoBlob);
        }
      } catch (err) {
        cleanupResources();
        throw err;
      }
      return;
    }

    eyeClosedFrames = 0;
    updateUI('Wajah siap. Silakan KEDIPKAN MATA untuk ambil foto otomatis.', true);
  });

  const frameLoop = async () => {
    if (!isRunning) return;
    if (videoEl.readyState >= 2) {
      try {
        await faceMesh.send({ image: videoEl });
      } catch {
        // Abaikan frame drop sesaat saat inisialisasi WebAssembly
      }
    }
    rafId = requestAnimationFrame(frameLoop);
  };

  rafId = requestAnimationFrame(frameLoop);

  return {
    stop: () => {
      cleanupResources();
      faceMesh.close().catch(() => {});
    }
  };
}
