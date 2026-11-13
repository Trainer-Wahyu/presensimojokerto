import { APP_CONFIG, supabase } from './supabase-client.js';
import { initPwaGate } from './pwa-gate.js';
import { getBoundDeviceId, validateOrBindDevice } from './device-id.js';
import { acquireVerifiedCoordinates } from './geo-guard.js';
import { startLivenessCapture } from './camera-liveness.js';

// =====================================================================
// 1. REGISTRASI SERVICE WORKER (SYARAT INSTALASI PWA)
// =====================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Registrasi Service Worker gagal:', err);
    });
  });
}

// =====================================================================
// 2. STATE APLIKASI & REFERENSI ELEMEN DOM
// =====================================================================
const appState = {
  deviceId: null,
  currentUser: null,
  verifiedCoords: null,
  cameraController: null,
  receiptPhotoUrl: null
};

const VIEW_IDS = ['view-login', 'view-location', 'view-camera', 'view-success'];

function switchView(activeViewId) {
  VIEW_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('hidden', id !== activeViewId);
    }
  });
}

function stopActiveCamera() {
  if (appState.cameraController && typeof appState.cameraController.stop === 'function') {
    appState.cameraController.stop();
    appState.cameraController = null;
  }
}

// =====================================================================
// 3. INISIALISASI GERBANG KEAMANAN PWA
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
  initPwaGate(
    {
      gateId: 'install-gate',
      appId: 'app-main',
      installBtnId: 'btn-install-pwa',
      instructionId: 'install-instructions',
      devBypass: APP_CONFIG.DEV_BYPASS_PWA_GATE
    },
    bootstrapAttendanceLifecycle
  );
});

// =====================================================================
// 4. SIKLUS HIDUP UTAMA PRESENSI (AKTIF HANYA SAAT PWA TERINSTAL)
// =====================================================================
async function bootstrapAttendanceLifecycle() {
  // Pastikan setiap sesi presensi selalu dimulai dari layar Login baru
  await supabase.auth.signOut().catch(() => {});

  // Buat / pulihkan identitas gawai unik (IndexedDB + localStorage + Hardware Hash)
  appState.deviceId = await getBoundDeviceId();

  const deviceBadge = document.getElementById('device-badge');
  if (deviceBadge) {
    deviceBadge.textContent = `Gawai: ${appState.deviceId.slice(0, 8)}...`;
  }

  bindUIEvents();
  switchView('view-login');
}

function bindUIEvents() {
  const loginForm = document.getElementById('login-form');
  const btnRetryGeo = document.getElementById('btn-retry-geo');
  const btnFinishExit = document.getElementById('btn-finish-exit');

  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }
  if (btnRetryGeo) {
    btnRetryGeo.addEventListener('click', runLocationCheckFlow);
  }
  if (btnFinishExit) {
    btnFinishExit.addEventListener('click', handleExitAndResetSession);
  }
}

// =====================================================================
// 5. ALUR TAHAP 1: AUTENTIKASI & DEVICE BINDING (1 AKUN = 1 GAWAI)
// =====================================================================
async function handleLoginSubmit(event) {
  event.preventDefault();

  const inputNip = document.getElementById('input-nip');
  const inputPassword = document.getElementById('input-password');
  const alertBox = document.getElementById('login-alert');
  const btnSubmit = document.getElementById('btn-submit-login');

  alertBox.classList.add('hidden');
  alertBox.textContent = '';
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Memverifikasi Akun & Gawai...';

  try {
    const rawIdentifier = inputNip.value.trim();
    const password = inputPassword.value;

    if (!rawIdentifier || !password) {
      throw new Error('NIP/Email dan kata sandi wajib diisi.');
    }

    const email = rawIdentifier.includes('@')
      ? rawIdentifier
      : `${rawIdentifier}@${APP_CONFIG.DEFAULT_EMAIL_DOMAIN}`;

    // 1. Autentikasi kredensial ke Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError || !authData?.user) {
      throw new Error('Autentikasi gagal: NIP atau kata sandi tidak sesuai.');
    }

    // 2. Validasi kecocokan gawai pada tabel profiles (1 Akun 1 Gawai)
    await validateOrBindDevice(supabase, authData.user.id, appState.deviceId);

    appState.currentUser = authData.user;
    inputPassword.value = ''; // Bersihkan password dari memori DOM

    // 3. Lanjut otomatis ke tahap pengecekan lokasi GPS
    await runLocationCheckFlow();
  } catch (err) {
    await supabase.auth.signOut().catch(() => {});
    appState.currentUser = null;
    alertBox.textContent = err.message || 'Terjadi kesalahan saat proses masuk.';
    alertBox.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Masuk & Verifikasi Lokasi';
  }
}

// =====================================================================
// 6. ALUR TAHAP 2: VERIFIKASI LOKASI & FILTER MOCK LOCATION
// =====================================================================
async function runLocationCheckFlow() {
  stopActiveCamera();
  switchView('view-location');

  const statusText = document.getElementById('geo-status-text');
  const errBox = document.getElementById('geo-error-box');
  const errMsg = document.getElementById('geo-error-msg');

  errBox.classList.add('hidden');
  statusText.textContent =
    'Memeriksa titik koordinat GPS dan integritas sensor perangkat. Pastikan GPS Akurasi Tinggi aktif...';

  try {
    // Ambil koordinat bersih dan lolos pemeriksaan heuristik anti-mock
    const coords = await acquireVerifiedCoordinates({
      maxAccuracyMeters: APP_CONFIG.MAX_GPS_ACCURACY_METERS,
      timeoutMs: 15000
    });

    appState.verifiedCoords = coords;

    const accuracyBadge = document.getElementById('gps-accuracy-badge');
    if (accuracyBadge) {
      accuracyBadge.textContent = `Akurasi: ±${Math.round(coords.accuracy)}m`;
    }

    // Lanjut otomatis ke tahap kamera Liveness Detection
    await runCameraLivenessFlow();
  } catch (geoErr) {
    errMsg.textContent = geoErr.message || 'Gagal memverifikasi lokasi perangkat.';
    errBox.classList.remove('hidden');
  }
}

// =====================================================================
// 7. ALUR TAHAP 3: KAMERA LIVENESS DETECTION & AUTO-CAPTURE (~200KB)
// =====================================================================
async function runCameraLivenessFlow() {
  switchView('view-camera');

  const instructionEl = document.getElementById('liveness-instruction');
  if (instructionEl) {
    instructionEl.textContent = 'Menyiapkan kamera depan & sensor wajah...';
  }

  try {
    appState.cameraController = await startLivenessCapture({
      videoId: 'camera-video',
      ovalId: 'face-oval',
      instructionId: 'liveness-instruction',
      maxPhotoKB: APP_CONFIG.TARGET_PHOTO_MAX_KB,
      onCaptured: handleCapturedAndSubmitAttendance
    });
  } catch (camErr) {
    // Jika kamera diblokir atau terdeteksi kamera virtual, kembalikan ke tampilan error lokasi dengan pesan jelas
    switchView('view-location');
    const errBox = document.getElementById('geo-error-box');
    const errMsg = document.getElementById('geo-error-msg');
    errMsg.textContent = camErr.message || 'Gagal mengakses kamera depan perangkat.';
    errBox.classList.remove('hidden');
  }
}

// =====================================================================
// 8. ALUR TAHAP 4: UNGGAH FOTO (~200KB) & VALIDASI RADIUS SERVER (RPC)
// =====================================================================
async function handleCapturedAndSubmitAttendance(compressedPhotoBlob) {
  const instructionEl = document.getElementById('liveness-instruction');
  if (instructionEl) {
    instructionEl.textContent = 'Mengunggah bukti foto & memvalidasi radius kantor di server...';
  }

  let uploadedFilePath = null;

  try {
    if (!appState.currentUser || !appState.verifiedCoords) {
      throw new Error('Sesi pengguna atau data koordinat tidak lengkap.');
    }

    const filePath = `${appState.currentUser.id}/${Date.now()}.jpg`;

    // 1. Unggah blob JPEG terkompresi (~200KB) ke Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(APP_CONFIG.STORAGE_BUCKET)
      .upload(filePath, compressedPhotoBlob, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (uploadError || !uploadData?.path) {
      throw new Error(`Gagal mengunggah foto bukti: ${uploadError?.message || 'Storage error'}`);
    }

    uploadedFilePath = uploadData.path;

    // 2. Panggil fungsi RPC PostgreSQL untuk validasi radius Haversine,
    //    kecocokan device_id, dan pencatatan timestamp server mutlak
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'validate_and_record_attendance',
      {
        p_device_id: appState.deviceId,
        p_lat: appState.verifiedCoords.latitude,
        p_lng: appState.verifiedCoords.longitude,
        p_foto_url: uploadedFilePath
      }
    );

    if (rpcError) {
      throw new Error(`Validasi server gagal: ${rpcError.message}`);
    }

    if (!rpcResult || rpcResult.success !== true) {
      throw new Error(
        rpcResult?.message || 'Posisi Anda berada di luar radius lokasi kantor yang diizinkan.'
      );
    }

    // 3. Tampilkan layar bukti kehadiran berhasil
    renderSuccessReceipt(compressedPhotoBlob, appState.verifiedCoords);
  } catch (submitErr) {
    // Hapus file foto yatim di Storage jika validasi radius/RPC server menolak presensi
    if (uploadedFilePath) {
      await supabase.storage
        .from(APP_CONFIG.STORAGE_BUCKET)
        .remove([uploadedFilePath])
        .catch(() => {});
    }

    // Tampilkan pesan penolakan di layar lokasi agar pengguna bisa memperbaiki posisi dan mengulang
    switchView('view-location');
    const errBox = document.getElementById('geo-error-box');
    const errMsg = document.getElementById('geo-error-msg');
    errMsg.textContent = submitErr.message;
    errBox.classList.remove('hidden');
  }
}

function renderSuccessReceipt(photoBlob, coords) {
  if (appState.receiptPhotoUrl) {
    URL.revokeObjectURL(appState.receiptPhotoUrl);
  }
  appState.receiptPhotoUrl = URL.createObjectURL(photoBlob);

  const sizeKB = (photoBlob.size / 1024).toFixed(1);
  const formattedTime = new Date().toLocaleString('id-ID', {
    dateStyle: 'full',
    timeStyle: 'medium'
  });

  document.getElementById('receipt-photo').src = appState.receiptPhotoUrl;
  document.getElementById('receipt-time').textContent = formattedTime;
  document.getElementById('receipt-size').innerHTML = `<strong>Ukuran Berkas:</strong> ${sizeKB} KB`;
  document.getElementById(
    'receipt-coords'
  ).innerHTML = `<strong>Koordinat:</strong> ${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`;

  switchView('view-success');
}

// =====================================================================
// 9. KELUAR & KUNCI KEMBALI SESI
// =====================================================================
async function handleExitAndResetSession() {
  stopActiveCamera();

  if (appState.receiptPhotoUrl) {
    URL.revokeObjectURL(appState.receiptPhotoUrl);
    appState.receiptPhotoUrl = null;
  }

  appState.currentUser = null;
  appState.verifiedCoords = null;

  await supabase.auth.signOut().catch(() => {});

  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.reset();

  switchView('view-login');
}
