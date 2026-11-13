import { APP_CONFIG } from './supabase-client.js';

/**
 * Memeriksa status izin geolokasi saat ini ('granted' | 'prompt' | 'denied' | 'unknown')
 */
export async function getGeolocationPermissionState() {
  if (!('permissions' in navigator) || !navigator.permissions.query) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/**
 * Memantau perubahan izin lokasi secara real-time.
 * Jika pegawai membuka Pengaturan HP, mengaktifkan izin Lokasi, lalu kembali ke PWA,
 * callback onGranted otomatis dijalankan.
 */
export async function watchGeolocationPermission(onGranted) {
  if (!('permissions' in navigator) || !navigator.permissions.query) {
    return null;
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    status.onchange = () => {
      if (status.state === 'granted' && typeof onGranted === 'function') {
        status.onchange = null;
        onGranted();
      }
    };
    return status;
  } catch {
    return null;
  }
}

/**
 * Mengambil satu sampel koordinat GPS mentah tanpa cache
 */
function requestRawPosition(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      const err = new Error('Perangkat tidak mendukung sensor geolokasi (GPS).');
      err.code = 'UNSUPPORTED';
      return reject(err);
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      async (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          const permState = await getGeolocationPermissionState();

          if (permState === 'prompt') {
            const err = new Error(
              'Permintaan izin lokasi belum dipilih. Ketuk tombol di bawah untuk memunculkan dialog izin GPS.'
            );
            err.code = 'PERMISSION_PROMPT';
            return reject(err);
          }

          const err = new Error(
            'Akses lokasi diblokir oleh pengaturan HP. Tekan lama ikon aplikasi Presensi di layar utama → Info Aplikasi → Izin → Lokasi → pilih "Izinkan saat aplikasi digunakan", lalu kembali ke layar ini.'
          );
          err.code = 'PERMISSION_DENIED';
          return reject(err);
        }

        if (error.code === error.POSITION_UNAVAILABLE) {
          const err = new Error(
            'Sinyal GPS tidak tersedia. Aktifkan GPS perangkat dengan mode Akurasi Tinggi.'
          );
          err.code = 'POSITION_UNAVAILABLE';
          return reject(err);
        }

        if (error.code === error.TIMEOUT) {
          const err = new Error(
            'Waktu pencarian titik GPS habis. Pastikan Anda berada di area terbuka dan coba lagi.'
          );
          err.code = 'TIMEOUT';
          return reject(err);
        }

        reject(new Error('Gagal membaca koordinat lokasi perangkat.'));
      },
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0
      }
    );
  });
}

/**
 * Memvalidasi metadata sensor GPS terhadap pola manipulasi Mock Location
 */
function analyzeSensorIntegrity(position, maxAccuracyMeters) {
  const { latitude, longitude, accuracy, altitude, altitudeAccuracy, speed } = position.coords;
  const driftMs = Math.abs(Date.now() - position.timestamp);

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error('Data koordinat GPS tidak valid.');
  }

  if (accuracy <= 0 || accuracy > maxAccuracyMeters) {
    throw new Error(
      `Akurasi lokasi tidak memenuhi syarat (${Math.round(accuracy)}m). Nonaktifkan Mock Location / Opsi Pengembang lalu coba kembali.`
    );
  }

  if (driftMs > 20000) {
    throw new Error(
      'Paket sinyal GPS kedaluwarsa atau tidak sinkron. Segarkan GPS perangkat Anda.'
    );
  }

  if (typeof speed === 'number' && speed > 150) {
    throw new Error('Terdeteksi anomali perpindahan lokasi tidak wajar.');
  }

  if (altitude === 0 && altitudeAccuracy === null && accuracy === 1) {
    throw new Error('Indikasi lokasi simulasi terdeteksi pada sensor perangkat.');
  }
}

/**
 * Fungsi utama: Memperoleh dan memverifikasi koordinat GPS bersih
 */
export async function acquireVerifiedCoordinates(options = {}) {
  const maxAccuracy = options.maxAccuracyMeters ?? APP_CONFIG.MAX_GPS_ACCURACY_METERS;
  const timeoutMs = options.timeoutMs ?? 15000;

  const position = await requestRawPosition(timeoutMs);
  analyzeSensorIntegrity(position, maxAccuracy);

  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp
  };
}
