const STORAGE_KEY = 'PRESENSI_BOUND_DEVICE_UUID';
const IDB_NAME = 'PresensiSecurityVault';
const IDB_STORE = 'device_identity';

/**
 * Membaca nilai dari IndexedDB dengan penanganan error aman
 */
function readFromIndexedDB() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_STORE)) {
          request.result.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(IDB_STORE, 'readonly');
        const getReq = tx.objectStore(IDB_STORE).get(STORAGE_KEY);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Menyimpan nilai ke IndexedDB
 */
function writeToIndexedDB(value) {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_STORE)) {
          request.result.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, STORAGE_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Membuat hash SHA-256 dari karakteristik perangkat keras layar & platform
 * Mencegah kloning UUID mentah ke tipe ponsel yang berbeda
 */
async function generateHardwareSignature() {
  const rawTraits = [
    navigator.platform || 'unknown',
    navigator.hardwareConcurrency || 0,
    navigator.deviceMemory || 0,
    `${screen.width}x${screen.height}`,
    screen.colorDepth || 24,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  ].join('|');

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawTraits));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/**
 * Menghasilkan UUID v4 kriptografis
 */
function createUUIDv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

/**
 * Mendapatkan atau membuat Device ID unik yang tersinkronisasi di localStorage & IndexedDB
 */
export async function getBoundDeviceId() {
  const localVal = localStorage.getItem(STORAGE_KEY);
  const idbVal = await readFromIndexedDB();

  // Pulihkan dari salah satu penyimpanan jika penyimpanan lainnya sempat terhapus
  let baseUuid = localVal || idbVal;
  if (!baseUuid) {
    baseUuid = createUUIDv4();
  }

  localStorage.setItem(STORAGE_KEY, baseUuid);
  await writeToIndexedDB(baseUuid);

  const hwSig = await generateHardwareSignature();
  return `${baseUuid}:${hwSig}`;
}

/**
 * Memverifikasi kecocokan gawai pada tabel profiles Supabase (1 Akun = 1 Gawai).
 * Jika akun belum pernah terikat, gawai saat ini otomatis didaftarkan secara permanen.
 */
export async function validateOrBindDevice(supabase, userId, currentDeviceId) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('registered_device_id, is_active')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw new Error('Data profil pegawai tidak ditemukan di sistem.');
  }

  if (!profile.is_active) {
    throw new Error('Status akun pegawai nonaktif. Hubungi administrator.');
  }

  // Kondisi 1: Login pertama kali -> ikat gawai ini ke database
  if (!profile.registered_device_id) {
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({ registered_device_id: currentDeviceId })
      .eq('id', userId);

    if (updateErr) {
      throw new Error('Gagal mengunci identitas gawai ke server.');
    }
    return { bound: true, isFirstTime: true };
  }

  // Kondisi 2: Gawai tidak cocok dengan yang terdaftar
  if (profile.registered_device_id !== currentDeviceId) {
    throw new Error(
      'Akses Ditolak: Akun Anda sudah terkunci pada gawai lain. Gunakan gawai terdaftar atau minta admin mereset perangkat.'
    );
  }

  // Kondisi 3: Gawai cocok
  return { bound: true, isFirstTime: false };
}
