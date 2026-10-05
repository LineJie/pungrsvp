// Daftar cabang PungRSVP — satu-satunya tempat backend mendefinisikan cabang.
//
// Kode cabang disimpan apa adanya di kolom `location` (teks) di semua tabel,
// jadi menambah cabang tidak butuh migrasi database.
//   surabaya = Graha Famili (Banana Leaf)
//   denpasar = The Magendra, Teuku Umar Barat (kode lama, JANGAN diganti
//              supaya data booking/staff/meja yang sudah ada tetap nyambung)
//   tunu     = Pung Pung Tunu, Kerobokan Kelod (cabang kedua di Denpasar)
export const BRANCHES = ["surabaya", "denpasar", "tunu"] as const;
export type Branch = typeof BRANCHES[number];

export function isValidBranch(loc: unknown): loc is Branch {
    return typeof loc === "string" && (BRANCHES as readonly string[]).includes(loc);
}

// Lokasi tak dikenal jatuh ke "surabaya" (perilaku lama, dipertahankan supaya
// data lama tanpa kolom location tetap terbaca).
export function normalizeBranch(loc: unknown): Branch {
    return isValidBranch(loc) ? loc : "surabaya";
}

// "Kota" sebuah cabang. Tunu = Denpasar: sama-sama WITA, rekening sama, dan
// leaderboard digabung. Dipakai untuk hal yang per-kota, bukan per-tempat.
export function branchCity(loc: unknown): "surabaya" | "denpasar" {
    const b = normalizeBranch(loc);
    return b === "surabaya" ? "surabaya" : "denpasar";
}
