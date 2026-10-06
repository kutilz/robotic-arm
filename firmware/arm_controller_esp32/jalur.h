/*
 * jalur.h: tipe jalur perintah (LOKAL vs CLOUD).
 *
 * Berkas sendiri, di-include paling atas, karena pembangkit prototipe Arduino
 * menaruh deklarasi semua fungsi .ino di atas berkas. Fungsi yang
 * mengembalikan Jalur (pemegangAktif, jalurOf) lalu dideklarasikan sebelum
 * enum-nya ada kalau enum itu tinggal di tengah .ino. Aturan pemakaiannya ada
 * di blok JALUR di arm_controller_esp32.ino.
 */
#pragma once
#include <stdint.h>

enum Jalur : uint8_t { JALUR_NONE = 0, JALUR_LOKAL = 1, JALUR_CLOUD = 2 };
