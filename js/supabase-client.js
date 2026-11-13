import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// =====================================================================
// KONFIGURASI PROYEK SUPABASE (SESUAIKAN DENGAN DASHBOARD ANDA)
// =====================================================================
export const APP_CONFIG = {
  SUPABASE_URL: 'https://GANTI-PROJECT-ID.supabase.co',
  SUPABASE_ANON_KEY: 'GANTI-DENGAN-SUPABASE-ANON-KEY',
  DEFAULT_EMAIL_DOMAIN: 'instansi.id', // Domain otomatis jika pegawai login dengan NIP
  STORAGE_BUCKET: 'bukti-presensi',
  TARGET_PHOTO_MAX_KB: 210,
  MAX_GPS_ACCURACY_METERS: 120,
  DEV_BYPASS_PWA_GATE: false // Set true HANYA saat debugging di browser laptop/PC
};

// Inisialisasi Singleton Supabase Client
export const supabase = createClient(
  APP_CONFIG.SUPABASE_URL,
  APP_CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
);
