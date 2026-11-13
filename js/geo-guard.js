import { APP_CONFIG } from './supabase-client.js';

/**
 * Mengambil satu sampel koordinat GPS mentah tanpa cache
 */
function requestRawPosition(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      return reject(new Error('Perangkat tidak mendukung sensor geolokasi (GPS).'));
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => {
        switch (error.code) {
          case error.PERMISSION_DENIED:
            reject(
              new Error(
                'Izin lokasi ditolak. Buka Pengaturan Aplikasi/Browser dan izinkan akses Lokasi.'
              )
            );
            break;
          case error.POSITION_UNAVAILABLE:
            reject(
              new Error(
                'Sinyal GPS tidak tersedia. Aktifkan GPS perangkat dengan mode Akurasi Tinggi.'
              )
            );
            break;
          case error.TIMEOUT:
            reject(
              new Error(
                'Waktu pencarian titik GPS habis. Pastikan Anda berada di area dengan sinyal terbuka.'
              )
            );
            break;
          default:
            reject(new Error('Gagal membaca koordinat lokasi perangkat.'));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0 // Wajib 0: larang browser memakai titik lokasi lama dari cache
      }
    );
  });
}

/**
 * Memvalidasi metadata sensor GPS terhadap pola manipulasi Mock Location
 */
function analyzeSensorIntegrity(position, maxAccuracyMeters) {
  const { latitude, longitude, accuracy, altitude, altitudeAccuracy, speed } = position.coords;
  const now = Date.now();
  const driftMs = Math.abs(now - position.timestamp);

  // 1. Validasi rentang koordinat bumi yang sah
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

  // 2. Deteksi akurasi palsu (Mock GPS sering menyuntikkan accuracy = 0 atau nilai terlalu besar)
  if (accuracy <= 0 || accuracy > maxAccuracyMeters) {
    throw new Error(
      `Akurasi lokasi tidak memenuhi syarat (${Math.round(accuracy)}m). Nonaktifkan Mock Location / Opsi Pengembang lalu coba kembali.`
    );
  }

  // 3. Deteksi selisih waktu injeksi paket GPS dengan jam perangkat (> 20 detik)
  if (driftMs > 20000) {
    throw new Error(
      'Paket sinyal GPS kedaluwarsa atau tidak sinkron. Segarkan GPS perangkat Anda.'
    );
  }

  // 4. Deteksi anomali kecepatan perpindahan mustahil (> 150 m/s atau 540 km/jam)
  if (typeof speed === 'number' && speed > 150) {
    throw new Error('Terdeteksi anomali perpindahan lokasi tidak wajar.');
  }

  // 5. Deteksi tanda khas emulator/mock provider (altitude tepat 0 dengan altitudeAccuracy null)
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
