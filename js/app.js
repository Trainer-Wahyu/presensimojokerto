import { APP_CONFIG, supabase } from './supabase-client.js';
import { initPwaGate } from './pwa-gate.js';
import { getBoundDeviceId, validateOrBindDevice } from './device-id.js';
import {
  acquireVerifiedCoordinates,
  watchGeolocationPermission
} from './geo-guard.js';
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
// 2. UTILITAS AUTO-RETRY DENGAN RANDOM JITTER (ANTI-THUNDERING HERD)
// =====================================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  if (!err) return false;
  if (err.nonRetryable === true) return false;

  const status = Number(err.status || err.statusCode || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const msg = String(err.message || err).toLowerCase();
  const transientKeywords = [
    'failed to fetch',
    'networkerror',
    'network request failed',
    'load failed',
    'timeout',
    'timed out',
    'rate limit',
    'too many requests',
    'service unavailable',
    'gateway',
    'connection',
    'econnreset',
    'fetch'
  ];

  return transientKeywords.some((kw) => msg.includes(kw));
}

async function executeWithRetry(operationFn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxJitterMs = 2500,
    onRetry = null
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operationFn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt > maxRetries || !isTransientError(err)) {
        throw err;
      }

      const backoff = baseDelayMs * attempt;
      const jitter = Math.floor(Math.random() * maxJitterMs);
      const waitMs = backoff + jitter;

      if (typeof onRetry === 'function') {
        onRetry(attempt, maxRetries, waitMs);
      }

      await sleep(waitMs);
    }
  }

  throw lastError;
}

// =====================================================================
// 3. STATE APLIKASI & NAVIGASI TAMPILAN
// =====================================================================
const appState = {
  deviceId: null,
  currentUser: null,
  userProfile: null,
  activeScheduleType: null, // 'datang' | 'pulang'
  verifiedCoords: null,
  cameraController: null,
  receiptPhotoUrl: null,
  lastReceiptPayload: null,
  permissionWatcher: null
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

function clearPermissionWatcher() {
  if (appState.permissionWatcher) {
    appState.permissionWatcher.onchange = null;
    appState.permissionWatcher = null;
  }
}

// =====================================================================
// 4. INISIALISASI GERBANG KEAMANAN PWA
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
// 5. SIKLUS HIDUP UTAMA PRESENSI (AKTIF HANYA SAAT PWA TERINSTAL)
// =====================================================================
async function bootstrapAttendanceLifecycle() {
  await supabase.auth.signOut().catch(() => {});

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
  const btnDownloadReceipt = document.getElementById('btn-download-receipt');
  const btnFinishExit = document.getElementById('btn-finish-exit');
  const btnFullscreen = document.getElementById('btn-fullscreen-lock');

  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }
  if (btnRetryGeo) {
    btnRetryGeo.addEventListener('click', runLocationCheckFlow);
  }
  if (btnDownloadReceipt) {
    btnDownloadReceipt.addEventListener('click', handleDownloadReceiptPng);
  }
  if (btnFinishExit) {
    btnFinishExit.addEventListener('click', handleExitAndCloseApp);
  }
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      const el = document.documentElement;
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    });
  }
}

// =====================================================================
// 6. ALUR TAHAP 1: AUTENTIKASI, PENGUNCIAN GAWAI, & VALIDASI JADWAL
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
    const rawIdentifier = inputNip.value.trim().toLowerCase();
    const password = inputPassword.value;

    if (!rawIdentifier || !password) {
      const err = new Error('NIP/Email dan kata sandi wajib diisi.');
      err.nonRetryable = true;
      throw err;
    }

    const email = rawIdentifier.includes('@')
      ? rawIdentifier
      : `${rawIdentifier}@${APP_CONFIG.DEFAULT_EMAIL_DOMAIN.toLowerCase()}`;

    // 1. Autentikasi kredensial ke Supabase Auth
    const authData = await executeWithRetry(
      async () => {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (error || !data?.user) {
          const rawMsg = error?.message || 'Kredensial tidak valid';
          const lowerMsg = rawMsg.toLowerCase();

          if (lowerMsg.includes('email not confirmed')) {
            const err = new Error(
              `Akun (${email}) belum terkonfirmasi di Supabase. Hubungi administrator.`
            );
            err.nonRetryable = true;
            throw err;
          }

          if (lowerMsg.includes('invalid login credentials')) {
            const err = new Error(
              `Login ditolak untuk akun (${email}). Periksa kembali NIP/Email dan kata sandi Anda.`
            );
            err.nonRetryable = true;
            throw err;
          }

          const retryErr = new Error(`Autentikasi gagal (${email}): ${rawMsg}`);
          retryErr.status = error?.status;
          throw retryErr;
        }

        return data;
      },
      {
        maxRetries: 3,
        baseDelayMs: 900,
        maxJitterMs: 2200,
        onRetry: (attempt, maxRetries) => {
          btnSubmit.textContent = `Jaringan sibuk, mencoba login ulang (${attempt}/${maxRetries})...`;
        }
      }
    );

    // 2. Validasi penguncian gawai dua arah (1 Akun = 1 Gawai & 1 Gawai = 1 Akun)
    btnSubmit.textContent = 'Memeriksa Keamanan Gawai...';
    await executeWithRetry(
      async () => {
        try {
          return await validateOrBindDevice(supabase, authData.user.id, appState.deviceId);
        } catch (bindErr) {
          if (String(bindErr.message || '').includes('Akses Ditolak')) {
            bindErr.nonRetryable = true;
          }
          throw bindErr;
        }
      },
      {
        maxRetries: 2,
        baseDelayMs: 800,
        maxJitterMs: 1800,
        onRetry: (attempt, maxRetries) => {
          btnSubmit.textContent = `Memverifikasi ulang gawai (${attempt}/${maxRetries})...`;
        }
      }
    );

    // 3. Validasi jadwal presensi datang/pulang & cek apakah sudah presensi hari ini
    btnSubmit.textContent = 'Memeriksa Jadwal Presensi...';
    const schedStatus = await executeWithRetry(
      async () => {
        const { data, error } = await supabase.rpc('check_attendance_schedule_status');
        if (error) {
          const rpcErr = new Error(`Gagal memeriksa jadwal presensi: ${error.message}`);
          rpcErr.status = error.status;
          throw rpcErr;
        }
        return data;
      },
      {
        maxRetries: 2,
        baseDelayMs: 800,
        maxJitterMs: 1800
      }
    );

    if (!schedStatus || schedStatus.allowed !== true) {
      const schedErr = new Error(
        schedStatus?.message || 'Saat ini di luar jadwal presensi yang diizinkan.'
      );
      schedErr.nonRetryable = true;
      throw schedErr;
    }

    // 4. Ambil identitas nama & NIP pegawai untuk ditampilkan pada bukti presensi
    const { data: profileData } = await supabase
      .from('profiles')
      .select('nama, nip')
      .eq('id', authData.user.id)
      .maybeSingle();

    appState.currentUser = authData.user;
    appState.userProfile = profileData || { nama: 'Pegawai', nip: rawIdentifier };
    appState.activeScheduleType = schedStatus.jenis_presensi;
    inputPassword.value = '';

    // 5. Lanjut otomatis ke tahap pengecekan lokasi GPS
    await runLocationCheckFlow();
  } catch (err) {
    await supabase.auth.signOut().catch(() => {});
    appState.currentUser = null;
    appState.userProfile = null;
    appState.activeScheduleType = null;
    alertBox.textContent = err.message || 'Terjadi kesalahan saat proses masuk.';
    alertBox.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Masuk & Verifikasi Lokasi';
  }
}

// =====================================================================
// 7. ALUR TAHAP 2: VERIFIKASI LOKASI, IZIN GPS & FILTER MOCK LOCATION
// =====================================================================
async function runLocationCheckFlow() {
  stopActiveCamera();
  clearPermissionWatcher();
  switchView('view-location');

  const statusText = document.getElementById('geo-status-text');
  const errBox = document.getElementById('geo-error-box');
  const errMsg = document.getElementById('geo-error-msg');
  const btnRetry = document.getElementById('btn-retry-geo');

  errBox.classList.add('hidden');
  btnRetry.disabled = true;
  btnRetry.textContent = 'Memeriksa Lokasi...';

  const jenisLabel =
    appState.activeScheduleType === 'pulang' ? 'Presensi Pulang' : 'Presensi Datang';
  statusText.textContent = `Memverifikasi titik GPS untuk ${jenisLabel}. Pastikan GPS Akurasi Tinggi aktif...`;

  try {
    const coords = await acquireVerifiedCoordinates({
      maxAccuracyMeters: APP_CONFIG.MAX_GPS_ACCURACY_METERS,
      timeoutMs: 15000
    });

    appState.verifiedCoords = coords;

    const accuracyBadge = document.getElementById('gps-accuracy-badge');
    if (accuracyBadge) {
      accuracyBadge.textContent = `Akurasi: ±${Math.round(coords.accuracy)}m`;
    }

    await runCameraLivenessFlow();
  } catch (geoErr) {
    errMsg.textContent = geoErr.message || 'Gagal memverifikasi lokasi perangkat.';
    errBox.classList.remove('hidden');
    btnRetry.disabled = false;

    if (geoErr.code === 'PERMISSION_PROMPT') {
      btnRetry.textContent = 'Izinkan Akses Lokasi Sekarang';
    } else if (geoErr.code === 'PERMISSION_DENIED') {
      btnRetry.textContent = 'Saya Sudah Mengaktifkan Izin, Periksa Lagi';
      appState.permissionWatcher = await watchGeolocationPermission(() => {
        runLocationCheckFlow();
      });
    } else {
      btnRetry.textContent = 'Coba Periksa Lokasi Lagi';
    }
  }
}

// =====================================================================
// 8. ALUR TAHAP 3: KAMERA LIVENESS DETECTION & AUTO-CAPTURE (~200KB)
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
    switchView('view-location');
    const errBox = document.getElementById('geo-error-box');
    const errMsg = document.getElementById('geo-error-msg');
    const btnRetry = document.getElementById('btn-retry-geo');
    errMsg.textContent = camErr.message || 'Gagal mengakses kamera depan perangkat.';
    btnRetry.disabled = false;
    btnRetry.textContent = 'Coba Lagi';
    errBox.classList.remove('hidden');
  }
}

// =====================================================================
// 9. ALUR TAHAP 4: UNGGAH FOTO, VALIDASI RPC, & AMBIL RIWAYAT HARI INI
// =====================================================================
async function fetchTodayAttendanceSummary(userId) {
  const todayLocal = new Date().toLocaleDateString('en-CA');
  const { data: logs } = await supabase
    .from('presensi_log')
    .select('jenis_presensi, created_at')
    .eq('user_id', userId)
    .eq('tanggal_lokal', todayLocal)
    .order('created_at', { ascending: true });

  const summary = {
    datangTime: null,
    pulangTime: null
  };

  (logs || []).forEach((item) => {
    const timeFormatted = new Date(item.created_at).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    if (item.jenis_presensi === 'pulang') {
      summary.pulangTime = `${timeFormatted} WIB`;
    } else {
      summary.datangTime = `${timeFormatted} WIB`;
    }
  });

  return summary;
}

async function handleCapturedAndSubmitAttendance(compressedPhotoBlob) {
  const instructionEl = document.getElementById('liveness-instruction');
  const setStatus = (msg) => {
    if (instructionEl) instructionEl.textContent = msg;
  };

  setStatus('Mengunggah bukti foto ke server...');
  let uploadedFilePath = null;

  try {
    if (!appState.currentUser || !appState.verifiedCoords) {
      const err = new Error('Sesi pengguna atau data koordinat tidak lengkap.');
      err.nonRetryable = true;
      throw err;
    }

    const filePath = `${appState.currentUser.id}/${Date.now()}.jpg`;

    // Tahap 4A: Unggah foto ke Supabase Storage
    const uploadData = await executeWithRetry(
      async () => {
        const { data, error } = await supabase.storage
          .from(APP_CONFIG.STORAGE_BUCKET)
          .upload(filePath, compressedPhotoBlob, {
            contentType: 'image/jpeg',
            upsert: true
          });

        if (error || !data?.path) {
          const uploadErr = new Error(
            `Gagal mengunggah foto bukti: ${error?.message || 'Storage error'}`
          );
          uploadErr.status = error?.statusCode || error?.status;
          throw uploadErr;
        }
        return data;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxJitterMs: 3000,
        onRetry: (attempt, maxRetries, waitMs) => {
          const sec = (waitMs / 1000).toFixed(1);
          setStatus(`Antrean unggah padat, mencoba ulang (${attempt}/${maxRetries}) dalam ${sec} dtk...`);
        }
      }
    );

    uploadedFilePath = uploadData.path;
    setStatus('Memvalidasi jadwal, radius kantor & mencatat kehadiran...');

    // Tahap 4B: Panggil RPC PostgreSQL
    const rpcResult = await executeWithRetry(
      async () => {
        const { data, error } = await supabase.rpc(
          'validate_and_record_attendance',
          {
            p_device_id: appState.deviceId,
            p_lat: appState.verifiedCoords.latitude,
            p_lng: appState.verifiedCoords.longitude,
            p_foto_url: uploadedFilePath
          }
        );

        if (error) {
          const rpcErr = new Error(`Validasi server gagal: ${error.message}`);
          rpcErr.status = error.status;
          throw rpcErr;
        }

        if (!data || data.success !== true) {
          const rejectErr = new Error(
            data?.message || 'Posisi Anda berada di luar radius lokasi kantor yang diizinkan.'
          );
          rejectErr.nonRetryable = true;
          throw rejectErr;
        }

        return data;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxJitterMs: 3000,
        onRetry: (attempt, maxRetries, waitMs) => {
          const sec = (waitMs / 1000).toFixed(1);
          setStatus(`Server sibuk, memvalidasi ulang (${attempt}/${maxRetries}) dalam ${sec} dtk...`);
        }
      }
    );

    // Tahap 4C: Ambil ringkasan riwayat presensi hari ini (Datang & Pulang)
    const todaySummary = await fetchTodayAttendanceSummary(appState.currentUser.id).catch(
      () => ({ datangTime: null, pulangTime: null })
    );

    renderSuccessReceipt(compressedPhotoBlob, appState.verifiedCoords, rpcResult, todaySummary);
  } catch (submitErr) {
    if (uploadedFilePath) {
      await supabase.storage
        .from(APP_CONFIG.STORAGE_BUCKET)
        .remove([uploadedFilePath])
        .catch(() => {});
    }

    switchView('view-location');
    const errBox = document.getElementById('geo-error-box');
    const errMsg = document.getElementById('geo-error-msg');
    const btnRetry = document.getElementById('btn-retry-geo');
    errMsg.textContent = submitErr.message;
    btnRetry.disabled = false;
    btnRetry.textContent = 'Coba Periksa Lokasi Lagi';
    errBox.classList.remove('hidden');
  }
}

function renderSuccessReceipt(photoBlob, coords, rpcResult, todaySummary) {
  if (appState.receiptPhotoUrl) {
    URL.revokeObjectURL(appState.receiptPhotoUrl);
  }
  appState.receiptPhotoUrl = URL.createObjectURL(photoBlob);

  const jenis = (rpcResult?.jenis_presensi || appState.activeScheduleType || 'datang').toLowerCase();
  const isPulang = jenis === 'pulang';

  const badgeEl = document.getElementById('receipt-type-badge');
  const titleEl = document.getElementById('receipt-title');
  const empInfoEl = document.getElementById('receipt-employee-info');

  if (badgeEl) {
    badgeEl.textContent = isPulang ? 'PRESENSI PULANG' : 'PRESENSI DATANG';
    badgeEl.className = isPulang
      ? 'inline-block px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/30 mb-1.5'
      : 'inline-block px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-sky-500/15 text-sky-300 border border-sky-500/30 mb-1.5';
  }

  const titleText =
    rpcResult?.message || (isPulang ? 'Berhasil Presensi Pulang' : 'Berhasil Presensi Datang');
  if (titleEl) titleEl.textContent = titleText;

  const empName = appState.userProfile?.nama || 'Pegawai';
  const empNip = appState.userProfile?.nip || '-';
  if (empInfoEl) {
    empInfoEl.textContent = `${empName} • NIP: ${empNip}`;
  }

  // Isi Ringkasan Riwayat Hari Ini
  const datangEl = document.getElementById('summary-datang-time');
  const pulangEl = document.getElementById('summary-pulang-time');

  const fallbackNowTime = `${new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })} WIB`;

  const resolvedDatang = todaySummary?.datangTime || (!isPulang ? fallbackNowTime : null);
  const resolvedPulang = todaySummary?.pulangTime || (isPulang ? fallbackNowTime : null);

  if (datangEl) {
    datangEl.textContent = resolvedDatang || 'Belum Presensi';
    datangEl.className = resolvedDatang
      ? 'block font-mono font-semibold text-xs text-emerald-400 mt-0.5'
      : 'block font-mono font-semibold text-xs text-slate-500 mt-0.5';
  }

  if (pulangEl) {
    pulangEl.textContent = resolvedPulang || 'Belum Presensi';
    pulangEl.className = resolvedPulang
      ? 'block font-mono font-semibold text-xs text-emerald-400 mt-0.5'
      : 'block font-mono font-semibold text-xs text-slate-500 mt-0.5';
  }

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

  // Simpan payload untuk generator PNG
  appState.lastReceiptPayload = {
    photoUrl: appState.receiptPhotoUrl,
    jenis,
    isPulang,
    titleText,
    empName,
    empNip,
    formattedTime,
    coordsText: `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`,
    datangText: resolvedDatang || 'Belum Presensi',
    pulangText: resolvedPulang || 'Belum Presensi',
    deviceShort: appState.deviceId ? appState.deviceId.slice(0, 12) : '-'
  };

  switchView('view-success');
}

// =====================================================================
// 10. GENERATOR UNDUH BUKTI PRESENSI DIGITAL (PNG)
// =====================================================================
async function handleDownloadReceiptPng() {
  const payload = appState.lastReceiptPayload;
  if (!payload) return;

  const btn = document.getElementById('btn-download-receipt');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Membuat Kartu Bukti PNG...';

  try {
    const img = new Image();
    img.src = payload.photoUrl;
    await img.decode();

    const width = 760;
    const height = 1140;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Latar belakang utama
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, width, height);

    // Kartu utama
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(36, 36, width - 72, height - 72, 36);
    ctx.fill();
    ctx.stroke();

    // Header Badge
    ctx.fillStyle = payload.isPulang ? 'rgba(245, 158, 11, 0.16)' : 'rgba(14, 165, 233, 0.16)';
    ctx.beginPath();
    ctx.roundRect(width / 2 - 140, 74, 280, 40, 20);
    ctx.fill();

    ctx.fillStyle = payload.isPulang ? '#fcd34d' : '#7dd3fc';
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(payload.isPulang ? 'PRESENSI PULANG' : 'PRESENSI DATANG', width / 2, 100);

    // Judul & Identitas
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px system-ui, -apple-system, sans-serif';
    ctx.fillText(payload.titleText, width / 2, 156);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 22px system-ui, -apple-system, sans-serif';
    ctx.fillText(payload.empName, width / 2, 196);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '18px monospace';
    ctx.fillText(`NIP: ${payload.empNip}`, width / 2, 226);

    ctx.fillStyle = '#64748b';
    ctx.font = '17px system-ui, -apple-system, sans-serif';
    ctx.fillText(payload.formattedTime, width / 2, 256);

    // Bingkai Foto Swafoto (3:4)
    const photoW = 330;
    const photoH = 440;
    const photoX = (width - photoW) / 2;
    const photoY = 286;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(photoX, photoY, photoW, photoH, 24);
    ctx.clip();
    ctx.drawImage(img, photoX, photoY, photoW, photoH);
    ctx.restore();

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(photoX, photoY, photoW, photoH, 24);
    ctx.stroke();

    // Kotak Ringkasan Riwayat Hari Ini
    const boxX = 76;
    const boxY = 758;
    const boxW = width - 152;
    ctx.fillStyle = '#020617';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, 148, 22);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
    ctx.fillText('RINGKASAN KEHADIRAN HARI INI', boxX + 26, boxY + 34);

    // Kolom Datang
    ctx.fillStyle = '#64748b';
    ctx.font = '16px system-ui, -apple-system, sans-serif';
    ctx.fillText('Presensi Datang', boxX + 26, boxY + 74);
    ctx.fillStyle = payload.datangText !== 'Belum Presensi' ? '#34d399' : '#64748b';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(payload.datangText, boxX + 26, boxY + 108);

    // Kolom Pulang
    const col2X = width / 2 + 20;
    ctx.fillStyle = '#64748b';
    ctx.font = '16px system-ui, -apple-system, sans-serif';
    ctx.fillText('Presensi Pulang', col2X, boxY + 74);
    ctx.fillStyle = payload.pulangText !== 'Belum Presensi' ? '#34d399' : '#64748b';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(payload.pulangText, col2X, boxY + 108);

    // Detail Koordinat & Status Server
    ctx.fillStyle = '#94a3b8';
    ctx.font = '17px monospace';
    ctx.fillText(`Koordinat : ${payload.coordsText}`, boxX + 10, 954);
    ctx.fillText(`ID Gawai  : ${payload.deviceShort}...`, boxX + 10, 986);

    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 17px system-ui, -apple-system, sans-serif';
    ctx.fillText('✔ Terverifikasi Server & GPS Akurasi Tinggi', boxX + 10, 1024);

    const pngBlob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const downloadUrl = URL.createObjectURL(pngBlob);
    const link = document.createElement('a');
    const dateStamp = new Date().toLocaleDateString('en-CA');
    link.href = downloadUrl;
    link.download = `Bukti_Presensi_${payload.jenis.toUpperCase()}_${payload.empNip}_${dateStamp}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
  } catch (err) {
    alert('Gagal membuat gambar bukti presensi: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// =====================================================================
// 11. SELESAI & KELUAR (AKHIRI SESI & TUTUP PWA JIKA DIIZINKAN OS)
// =====================================================================
async function handleExitAndCloseApp() {
  stopActiveCamera();
  clearPermissionWatcher();

  if (appState.receiptPhotoUrl) {
    URL.revokeObjectURL(appState.receiptPhotoUrl);
    appState.receiptPhotoUrl = null;
  }

  appState.currentUser = null;
  appState.userProfile = null;
  appState.activeScheduleType = null;
  appState.verifiedCoords = null;
  appState.lastReceiptPayload = null;

  await supabase.auth.signOut().catch(() => {});

  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.reset();

  switchView('view-login');

  // Coba tutup jendela PWA secara langsung; jika dibatasi kebijakan OS/browser,
  // layar sudah aman terkunci kembali di halaman login awal.
  try {
    window.close();
  } catch {
    // Diabaikan jika OS tidak mengizinkan penutupan jendela via skrip
  }
}
