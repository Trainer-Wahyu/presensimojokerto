// Tangkap event instalasi di level teratas modul agar tidak terlewat
// sebelum DOM selesai dimuat di Chrome Android
let deferredInstallPrompt = null;
let installButtonRef = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installButtonRef) {
    installButtonRef.classList.remove('hidden');
  }
});

/**
 * Memeriksa apakah aplikasi berjalan sebagai PWA terinstal (Standalone / Fullscreen)
 */
export function isRunningAsInstalledPWA(devBypass = false) {
  if (devBypass) return true;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
  const isIOSHomeScreen = window.navigator.standalone === true;

  return isStandalone || isFullscreen || isIOSHomeScreen;
}

/**
 * Mengunci tampilan Fullscreen, mematikan klik kanan/long-press, dan menahan tombol Back Android
 */
export function enforceKioskLock(fullscreenBtnId = 'btn-fullscreen-lock') {
  const triggerFullscreen = () => {
    const docEl = document.documentElement;
    if (!document.fullscreenElement) {
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(() => {});
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      }
    }
  };

  // Aktifkan fullscreen saat sentuhan layar pertama kali
  document.addEventListener('pointerdown', triggerFullscreen, { once: true });

  // Hubungkan tombol manual layar penuh jika tersedia
  const fsBtn = document.getElementById(fullscreenBtnId);
  if (fsBtn) {
    fsBtn.addEventListener('click', triggerFullscreen);
  }

  // Jebakan navigasi Back (mencegah keluar tidak sengaja via gestur swipe back)
  window.history.pushState(null, '', window.location.href);
  window.addEventListener('popstate', () => {
    window.history.pushState(null, '', window.location.href);
    triggerFullscreen();
  });

  // Matikan menu konteks (klik kanan / tekan lama teks)
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Menginisialisasi Gerbang PWA:
 * Memblokir fitur utama jika dibuka di tab browser biasa, dan mengeksekusi
 * callback onAuthorizedStart hanya jika dibuka dari ikon PWA terinstal.
 */
export function initPwaGate(options, onAuthorizedStart) {
  const {
    gateId = 'install-gate',
    appId = 'app-main',
    installBtnId = 'btn-install-pwa',
    instructionId = 'install-instructions',
    devBypass = false
  } = options;

  const gateEl = document.getElementById(gateId);
  const appEl = document.getElementById(appId);
  installButtonRef = document.getElementById(installBtnId);

  // JIKA DIBUKA DI TAB BROWSER BIASA: Blokir aplikasi & tampilkan tombol instal
  if (!isRunningAsInstalledPWA(devBypass)) {
    if (gateEl) gateEl.classList.remove('hidden');
    if (appEl) appEl.remove(); // Hapus elemen aplikasi utama dari DOM demi keamanan

    if (installButtonRef) {
      if (deferredInstallPrompt) {
        installButtonRef.classList.remove('hidden');
      }

      installButtonRef.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          installButtonRef.classList.add('hidden');
        }
        deferredInstallPrompt = null;
      });
    }

    window.addEventListener('appinstalled', () => {
      const instructionEl = document.getElementById(instructionId);
      if (instructionEl) {
        instructionEl.innerHTML = `
          <p class="text-emerald-400 font-semibold">
            ✅ Instalasi berhasil! Tutup browser ini, lalu buka aplikasi <strong>Presensi</strong> melalui ikon di layar utama HP Anda.
          </p>
        `;
      }
    });

    return;
  }

  // JIKA SUDAH TERINSTAL: Hancurkan gerbang instalasi & aktifkan fitur aplikasi
  if (gateEl) gateEl.remove();
  if (appEl) appEl.classList.remove('hidden');

  enforceKioskLock();
  onAuthorizedStart();
}
