"""Paket kontrol & analisis lengan robot 6-DOF cycloidal.

Modul:
  config      - parameter fisik (link, massa, motor, konfigurasi sendi)
  torque      - perhitungan torsi statik & sizing reduksi cycloidal
  kinematics  - forward kinematics berbasis parameter Denavit-Hartenberg
  bridge      - bridge digital twin (serial Arduino <-> WebSocket web)
"""

__version__ = "0.1.0"
