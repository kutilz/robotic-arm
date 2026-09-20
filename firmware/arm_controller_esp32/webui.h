// webui.h - halaman kontrol bawaan ESP32 (port 80), terpisah dari Arm Studio.
//
// Kenapa ada: Arm Studio belum full fungsional, tapi demo tetap butuh satu
// pengendali yang bisa dipakai apa adanya tanpa menjalankan apa pun di laptop.
// Halaman ini sengaja sederhana: cukup buka http://<ip-esp32>/ dari HP atau
// laptop yang sejaringan, tanpa install, tanpa build, tanpa Python bridge.
//
// Halaman ini TIDAK punya protokol sendiri. Dia bicara ke WebSocket port 81
// dengan perintah yang sama persis dengan yang dipakai studio (goto, estop,
// resume, cal_get, cal_set, cal_save, plus gripper/servo_us/servo_auto untuk
// kartu gripper), jadi menambah halaman ini tidak menambah permukaan API
// yang harus dijaga. Nomor pin TIDAK ditulis di HTML: diambil runtime dari
// /api/info yang dibangun dari konstanta firmware, supaya angka yang
// ditunjukkan ke dosen tidak mungkin basi terhadap kode.

#pragma once
#include <pgmspace.h>

const char WEBUI_HTML[] PROGMEM = R"HTMLPAGE(<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kontrol Lengan 6-DOF</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#14161a;color:#e6e8ec;font:15px/1.5 system-ui,Segoe UI,sans-serif;padding:14px;max-width:760px;margin:0 auto}
h1{font-size:19px;margin-bottom:2px}
.sub{color:#8b93a1;font-size:13px;margin-bottom:14px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.dot{width:10px;height:10px;border-radius:50%;background:#e5484d;flex:none}
.dot.on{background:#30a46c}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 16px;color:#fff;background:#2c313a;cursor:pointer}
button:active{transform:translateY(1px)}
button.stop{background:#e5484d;flex:1}
button.go{background:#30a46c}
button.mini{padding:4px 9px;font-size:11px;color:#9aa3b2;align-self:center}
.card{background:#1b1e24;border:1px solid #262b33;border-radius:10px;padding:12px;margin-bottom:10px}
.row{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.nm{font-weight:600}
.tag{font-size:11px;padding:2px 7px;border-radius:99px;background:#2c313a;color:#9aa3b2}
.tag.srv{background:#2b3a52;color:#8ec1ff}
.pin{margin-left:auto;font-size:12px;color:#8b93a1;font-family:ui-monospace,Consolas,monospace}
input[type=range]{width:100%;accent-color:#5b8dee}
.val{display:flex;justify-content:space-between;font-size:12px;color:#8b93a1;font-family:ui-monospace,Consolas,monospace}
.val b{color:#e6e8ec;font-weight:600}
.warn{color:#f5a524}
.ok{color:#30a46c}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:4px 6px;border-bottom:1px solid #262b33;vertical-align:top}
td:first-child{color:#8b93a1;white-space:nowrap;width:40%}
code{font-family:ui-monospace,Consolas,monospace;color:#8ec1ff}
h2{font-size:14px;margin:18px 0 8px;color:#9aa3b2;text-transform:uppercase;letter-spacing:.06em}
select{font:inherit;background:#2c313a;color:#e6e8ec;border:1px solid #3a414d;border-radius:8px;padding:9px 10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.lbl{font-size:12px;color:#8b93a1;display:block;margin-bottom:4px}
.msg{font-size:12px;color:#8b93a1;min-height:1.4em;font-family:ui-monospace,Consolas,monospace}
.hint{font-size:12px;color:#8b93a1;margin-top:8px}
</style></head><body>

<h1>Kontrol Lengan 6-DOF</h1>
<div class="sub" id="host">menyambung...</div>

<div class="bar">
  <span class="dot" id="dot"></span><span id="st">terputus</span>
  <button class="stop" id="bstop">E-STOP</button>
  <button class="go" id="bres">RESUME</button>
  <button id="bhome">KE POSE 0</button>
  <button id="bsimpan">SIMPAN NVS</button>
</div>

<div id="joints"></div>

<h2>Gripper</h2>
<div class="card">
  <div class="row"><span class="nm">Gripper</span>
    <span class="tag srv">servo MG90S</span>
    <span class="pin" id="gpin">-</span></div>

  <span class="lbl">Pulsa mentah (tidak bergantung kalibrasi)</span>
  <input type="range" id="gus" min="500" max="2500" step="5" value="1500">
  <div class="val"><span>pulsa <b id="gusv">1500</b> us</span>
    <span>mode <b id="gmode">auto</b></span></div>

  <span class="lbl" style="margin-top:10px">Sudut (lewat pemetaan firmware)</span>
  <input type="range" id="gdeg" min="0" max="90" step="1" value="45">
  <div class="val"><span>target <b id="gdegv">45.0</b>&deg;</span>
    <span>aktual <b id="gact">-</b>&deg;</span></div>

  <div class="bar" style="margin:12px 0 0">
    <button class="go" id="bgtengah">TENGAHKAN</button>
    <button id="bgauto">AUTO</button>
    <button id="bglemas">LEMASKAN</button>
  </div>

  <div id="gukur" style="display:none;margin-top:12px;border-top:1px solid #262b33;padding-top:10px">
    <div class="lbl">Servo lemas dan bebas diputar tangan. Bawa rahang ke posisi
      tertutup, tekan CATAT TUTUP, lalu ke posisi terbuka dan tekan CATAT BUKA.
      Angka <b>aktual</b> di atas hidup terus selama kamu menggerakkannya.</div>
    <div class="bar">
      <button id="bgtutup">CATAT TUTUP</button>
      <button id="bgbuka">CATAT BUKA</button>
    </div>
    <div class="val"><span>tutup <b id="gvtutup">-</b>&deg;</span>
      <span>buka <b id="gvbuka">-</b>&deg;</span></div>
  </div>

  <div class="grid" style="margin-top:10px">
    <div><span class="lbl">Sudut di pulsa minimum</span>
      <input type="number" id="gmin" step="0.1" style="width:100%;font:inherit;background:#2c313a;color:#e6e8ec;border:1px solid #3a414d;border-radius:8px;padding:9px 10px"></div>
    <div><span class="lbl">Sudut di pulsa maksimum</span>
      <input type="number" id="gmax" step="0.1" style="width:100%;font:inherit;background:#2c313a;color:#e6e8ec;border:1px solid #3a414d;border-radius:8px;padding:9px 10px"></div>
  </div>
  <div class="bar">
    <button id="bgterap">TERAPKAN BATAS</button>
    <button id="bgsimpan">SIMPAN KE NVS</button>
  </div>

  <div class="msg" id="gmsg"></div>
  <div class="hint">Gripper <b>bukan DOF</b>: tidak ada di <code>angles[]</code>,
    tidak punya joint limit, dan tidak ikut NOL SEMUA.<br>
    <b>Torsi tidak pernah ditahan.</b> Rahang seret dan torsi MG90S kecil, jadi
    perintah sudut melepas torsinya sendiri begitu rahang sampai, dan paling lama
    3 detik kalau tidak pernah sampai (mencengkeram benda, atau kena titik macet).
    Setelah itu yang menahan benda adalah gesekan mekanismenya. Slider
    <b>pulsa mentah</b> dikecualikan karena itu jalur kalibrasi yang memang perlu
    pulsa bertahan, pakai seperlunya saja.</div>
</div>

<h2>Driver dan suara</h2>
<div class="card">
  <div class="grid">
    <div><span class="lbl">Microstep</span>
      <select id="ms" style="width:100%">
        <option value="1">1 (full step)</option><option value="2">2</option>
        <option value="4">4</option><option value="8">8</option>
        <option value="16">16</option><option value="32">32</option>
        <option value="64">64</option><option value="128">128</option>
        <option value="256">256</option></select></div>
    <div><span class="lbl">Chopper</span>
      <select id="ch" style="width:100%">
        <option value="1">spreadCycle (torsi, berisik)</option>
        <option value="0">stealthChop (senyap)</option></select></div>
  </div>
  <div class="bar">
    <select id="sj"></select>
    <button id="bnada">Nada 440 Hz</button>
    <button id="bsweep">Sweep robot</button>
  </div>
  <div class="msg" id="msg"></div>
  <div class="hint">Bunyi khas A4988 itu bunyi chopper di microstep rendah.
    Pilih <b>microstep 1 atau 2</b> dengan <b>spreadCycle</b>, lalu gerakkan slider sendi.
    Microstep tinggi plus stealthChop membuatnya nyaris senyap.
    Mengubah microstep otomatis menghitung ulang step per derajat, sudut tetap benar.</div>
</div>

<h2>Info pin dan status perangkat</h2>
<div class="card"><table id="info"><tr><td>memuat...</td><td></td></tr></table></div>

<script>
const JOINTS=[
 {n:"J1 Base yaw",t:"stepper"},{n:"J2 Shoulder",t:"stepper"},
 {n:"J3 Elbow",t:"stepper"},{n:"J4 Wrist roll",t:"stepper"},
 {n:"J5 Wrist pitch",t:"servo"},{n:"J6 End roll",t:"servo"}];
const tgt=[0,0,0,0,0,0];
let ws,kirimTertunda=false,info=null;
// Sendi mana yang menunggu ack cal_zero. Ack firmware tidak menyebut nomor
// sendinya, dan menebak dari "sendi terakhir yang disentuh" tidak aman kalau
// ada dua halaman terbuka sekaligus.
let nolTertunda=null;

const el=document.getElementById("joints");
JOINTS.forEach((j,i)=>{
  const d=document.createElement("div");d.className="card";d.id="cd"+i;
  d.innerHTML=`<div class="row"><span class="nm">${j.n}</span>
    <span class="tag ${j.t==="servo"?"srv":""}">${j.t}</span>
    <span class="pin" id="pin${i}">-</span>
    <button class="mini" id="bz${i}">JADIKAN NOL</button></div>
    <input type="range" id="sl${i}" min="-180" max="180" step="0.5" value="0">
    <div class="val"><span>target <b id="tg${i}">0.0</b>&deg;</span>
    <span>aktual <b id="ac${i}">-</b>&deg;</span></div>`;
  el.appendChild(d);
});
JOINTS.forEach((j,i)=>{
  document.getElementById("sl"+i).addEventListener("input",e=>{
    tgt[i]=parseFloat(e.target.value);
    document.getElementById("tg"+i).textContent=tgt[i].toFixed(1);
    jadwalkanKirim();
  });
  /* JADIKAN NOL = homing. Sendi dibawa ke pose home dulu (stepper open-loop:
     e-stop lalu dorong tangan; servo: geser slider sampai posenya benar), baru
     tombol ini menetapkan pose itu sebagai 0. Firmware yang memutuskan caranya
     per sendi, halaman ini tidak perlu tahu sendi mana punya encoder. */
  document.getElementById("bz"+i).onclick=()=>{
    const nama=j.n.split(" ")[0];
    if(!confirm(nama+": jadikan pose FISIK yang sekarang sebagai 0 derajat?"))return;
    nolTertunda=i; lapor("nol "+nama+"...");
    kirim({cmd:"cal_zero",joint:i+1});
  };
});

// Throttle 50 ms: slider bisa memicu ratusan event per detik, dan menembakkan
// goto sebanyak itu menumpuk antrean di sisi ESP32 lalu tumpah sekaligus.
function jadwalkanKirim(){
  if(kirimTertunda)return; kirimTertunda=true;
  setTimeout(()=>{kirimTertunda=false;kirim({cmd:"goto",angles:tgt});},50);
}
function kirim(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); }

/* ---------------- gripper (servo indeks 2, BUKAN sendi) ----------------
   Dua jalur sengaja dipisah dan tidak digabung jadi satu slider:

   - servo_us : lebar pulsa MENTAH plus mode manual. Firmware berhenti menimpa
     pulsa itu tiap putaran loop, jadi horn benar benar diam. Ini satu satunya
     jalur yang artinya tidak bergantung pada kalibrasi, karena itu inilah yang
     dipakai sebelum rahang terpasang.
   - gripper  : lewat pemetaan servoAngMin..servoAngMax, sekaligus melepas mode
     manual. Baru berarti setelah batas min/max benar.

   Keduanya disinkronkan di layar supaya halaman tidak pernah menunjukkan dua
   posisi yang saling bertentangan. */
const GRIP=2;
let gripLim={usMin:500,usMax:2500,usCenter:1500,angMin:0,angMax:90};
let gripAntre=null,gripTertunda=false,calTerakhir=null;
let gAkt=null;   // sudut gripper terukur terakhir (dari pot, bukan perintah)

function jadwalkanGrip(o){
  gripAntre=o;
  if(gripTertunda)return; gripTertunda=true;
  setTimeout(()=>{gripTertunda=false;if(gripAntre){kirim(gripAntre);gripAntre=null;}},50);
}
const gUsKeDeg=u=>gripLim.angMin+((u-gripLim.usMin)/(gripLim.usMax-gripLim.usMin))*(gripLim.angMax-gripLim.angMin);
const gDegKeUs=d=>gripLim.usMin+((d-gripLim.angMin)/(gripLim.angMax-gripLim.angMin))*(gripLim.usMax-gripLim.usMin);

const gUs=document.getElementById("gus"), gDeg=document.getElementById("gdeg");
function gTampil(us,deg,manual){
  gUs.value=us; gDeg.value=deg;
  document.getElementById("gusv").textContent=Math.round(us);
  document.getElementById("gdegv").textContent=deg.toFixed(1);
  if(manual!=null)document.getElementById("gmode").textContent=manual?"manual":"auto";
}
function gLapor(t){document.getElementById("gmsg").textContent=t;}

gUs.addEventListener("input",e=>{
  const us=parseFloat(e.target.value);
  gTampil(us,gUsKeDeg(us),true);
  jadwalkanGrip({cmd:"servo_us",servo:GRIP,us:Math.round(us)});
});
gDeg.addEventListener("input",e=>{
  const d=parseFloat(e.target.value);
  gTampil(gDegKeUs(d),d,false);
  jadwalkanGrip({cmd:"gripper",deg:d});
});

// Titik tengah TERUKUR (servoUsCenter), bukan (min+maks)/2: travel servo tidak
// simetris terhadap pulsa, dan yang dipakai harus titik yang benar benar diukur.
document.getElementById("bgtengah").onclick=()=>{
  const us=gripLim.usCenter;
  gModeLemas(false);
  gTampil(us,gUsKeDeg(us),true);
  kirim({cmd:"servo_us",servo:GRIP,us:Math.round(us)});
  gLapor("gripper dikunci di titik tengah "+Math.round(us)+" us, aman untuk dirakit");
};
document.getElementById("bgauto").onclick=()=>{
  gModeLemas(false);
  document.getElementById("gmode").textContent="auto";
  kirim({cmd:"servo_auto",servo:GRIP});
};

/* Mode lemas: pulsa dihentikan, tangan yang menggerakkan rahang, servo cuma
   jadi sensor. Kedua slider DIKUNCI selama mode ini, bukan cuma dibiarkan,
   karena menggeser salah satunya akan menulis pulsa dan itu menghidupkan servo
   lagi tepat saat jari masih memegang rahang. Keluar lewat TENGAHKAN/AUTO. */
function gModeLemas(on){
  [gUs,gDeg].forEach(s=>{s.disabled=on;s.style.opacity=on?0.35:1;});
  document.getElementById("gukur").style.display=on?"":"none";
  if(on)document.getElementById("gusv").textContent="lemas";
}
document.getElementById("bglemas").onclick=()=>{
  gModeLemas(true);
  document.getElementById("gmode").textContent="lemas";
  kirim({cmd:"servo_limp",servo:GRIP});
  gLapor("servo lemas, gerakkan rahang dengan tangan");
};

// Catat kedua ujung dari pembacaan pot, bukan dari perintah. Mana yang jadi
// min dan mana yang jadi maks ditentukan angkanya sendiri, supaya arah pasang
// rahang (tutup di pulsa rendah atau tinggi) tidak perlu ditebak lebih dulu.
let gTutup=null,gBuka=null;
function gIsiBatas(){
  if(gTutup==null||gBuka==null)return;
  document.getElementById("gmin").value=Math.min(gTutup,gBuka).toFixed(1);
  document.getElementById("gmax").value=Math.max(gTutup,gBuka).toFixed(1);
  gLapor("batas terisi "+Math.min(gTutup,gBuka).toFixed(1)+" sampai "
    +Math.max(gTutup,gBuka).toFixed(1)+" derajat, tekan TERAPKAN BATAS");
}
function gCatat(nama){
  if(gAkt==null){gLapor("belum ada pembacaan aktual dari pot servo");return;}
  const v=gAkt;
  if(nama==="tutup"){gTutup=v;document.getElementById("gvtutup").textContent=v.toFixed(1);}
  else{gBuka=v;document.getElementById("gvbuka").textContent=v.toFixed(1);}
  gLapor(nama+" dicatat di "+v.toFixed(1)+" derajat");
  gIsiBatas();
}
document.getElementById("bgtutup").onclick=()=>gCatat("tutup");
document.getElementById("bgbuka").onclick=()=>gCatat("buka");

/* Penyempitan batas dikerjakan firmware lewat grip_limits, BUKAN dengan
   cal_set servo_ang_min/max dari sini.

   Sebabnya jebakan yang mahal: di firmware, servo_ang_min/max terikat ke
   servo_us_min/max. Menulis sudut saja membuat rentang kerja yang sempit itu
   terbentang ke SELURUH span pulsa, jadi perintah "buka" malah mendorong servo
   jauh melewati stop fisik rahang. Firmware menggeser sudut, pulsa, dan mV
   sekaligus supaya skala fisiknya tidak berubah. */
document.getElementById("bgterap").onclick=()=>{
  const lo=parseFloat(document.getElementById("gmin").value);
  const hi=parseFloat(document.getElementById("gmax").value);
  if(!isFinite(lo)||!isFinite(hi)){gLapor("min dan maks harus angka");return;}
  if(lo>=hi){gLapor("min harus lebih kecil dari maks");return;}
  gLapor("mengirim batas gripper "+lo+" sampai "+hi+" derajat...");
  kirim({cmd:"grip_limits",min:lo,max:hi});
};
document.getElementById("bgsimpan").onclick=()=>{
  gLapor("menyimpan ke NVS...");
  kirim({cmd:"cal_save"});
};

document.getElementById("bstop").onclick=()=>kirim({cmd:"estop"});
document.getElementById("bres").onclick=()=>kirim({cmd:"resume"});
/* Nol hasil JADIKAN NOL yang bisa bertahan cuma yang punya angka absolut:
   offset encoder (J1) dan sumbu sudut servo (J5/J6). Sendi open-loop tetap
   hilang saat reboot karena step counter memang tidak menyimpan apa pun. */
document.getElementById("bsimpan").onclick=()=>{
  lapor("menyimpan kalibrasi ke NVS...");
  kirim({cmd:"cal_save"});
};
/* Ini MENGGERAKKAN lengan ke pose nol, bukan menetapkan nol. Dulu labelnya
   "NOL SEMUA" dan itu berbahaya justru karena sekarang ada tombol yang benar
   benar menetapkan nol: satu salah pencet saat home masih meleset berarti
   keenam sendi berangkat sekaligus ke pose yang salah. */
document.getElementById("bhome").onclick=()=>{
  if(!confirm("Gerakkan KEENAM sendi ke 0 derajat sekarang?"))return;
  for(let i=0;i<6;i++){tgt[i]=0;
    document.getElementById("sl"+i).value=0;
    document.getElementById("tg"+i).textContent="0.0";}
  kirim({cmd:"goto",angles:tgt});
};

const pesan=document.getElementById("msg");
function lapor(t){pesan.textContent=t;}

// Microstep dan chopper dikirim lewat cal_set, jalur kalibrasi yang sudah ada,
// bukan perintah baru: firmware yang menghitung ulang step per derajat dan
// menulis ulang register keempat driver, jadi sudut sendi tetap benar.
document.getElementById("ms").onchange=e=>{
  lapor("mengirim microstep "+e.target.value+"...");
  kirim({cmd:"cal_set",tmc_microstep:parseInt(e.target.value)});
};
document.getElementById("ch").onchange=e=>{
  lapor("mengirim chopper...");
  kirim({cmd:"cal_set",tmc_spread:parseInt(e.target.value)});
};
document.getElementById("bnada").onclick=()=>{
  lapor("membunyikan nada...");
  kirim({cmd:"nada",joint:parseInt(document.getElementById("sj").value),hz:440,ms:500});
};
document.getElementById("bsweep").onclick=()=>{
  lapor("sweep 200 sampai 2000 Hz...");
  kirim({cmd:"sweep",joint:parseInt(document.getElementById("sj").value)});
};

function status(ok,teks){
  document.getElementById("dot").className="dot"+(ok?" on":"");
  document.getElementById("st").textContent=teks;
}

function sambung(){
  ws=new WebSocket("ws://"+location.hostname+":81");
  ws.onopen=()=>{status(true,"tersambung");kirim({cmd:"cal_get"});};
  ws.onclose=()=>{status(false,"terputus, mencoba lagi");setTimeout(sambung,1500);};
  ws.onerror=()=>ws.close();
  ws.onmessage=e=>{
    let m;try{m=JSON.parse(e.data)}catch(_){return}
    if(m.type==="feedback"){
      if(m.angles)m.angles.forEach((a,i)=>{
        const n=document.getElementById("ac"+i); if(n)n.textContent=a.toFixed(1);});
      status(true,m.estop?"E-STOP AKTIF":"tersambung");
      document.getElementById("dot").className="dot"+(m.estop?"":" on");
      // Sudut gripper aktual berasal dari wiper pot MG90S lewat ADS1115 kanal
      // A2, bukan dari perintah, jadi ini yang membuktikan servo benar sampai.
      if(m.grip!=null){gAkt=m.grip;
        document.getElementById("gact").textContent=m.grip.toFixed(1);}
    }else if(m.type==="cal"){
      calTerakhir=m;
      // Batas slider diambil dari joint_min/joint_max firmware, bukan ditebak
      // di HTML, supaya slider tidak pernah bisa meminta sudut di luar limit.
      if(m.joint_min&&m.joint_max)for(let i=0;i<6;i++){
        const s=document.getElementById("sl"+i);
        s.min=m.joint_min[i];s.max=m.joint_max[i];
      }
      // Alasan yang sama untuk gripper: travel dan titik tengahnya milik
      // firmware, halaman ini tidak boleh menawarkan pulsa di luar itu.
      if(m.servo_us_min)gripLim.usMin=m.servo_us_min[GRIP];
      if(m.servo_us_max)gripLim.usMax=m.servo_us_max[GRIP];
      if(m.servo_us_center)gripLim.usCenter=m.servo_us_center[GRIP];
      if(m.servo_ang_min)gripLim.angMin=m.servo_ang_min[GRIP];
      if(m.servo_ang_max)gripLim.angMax=m.servo_ang_max[GRIP];
      gUs.min=gripLim.usMin; gUs.max=gripLim.usMax;
      gDeg.min=gripLim.angMin; gDeg.max=gripLim.angMax;
      const gmin=document.getElementById("gmin"), gmax=document.getElementById("gmax");
      if(document.activeElement!==gmin)gmin.value=gripLim.angMin;
      if(document.activeElement!==gmax)gmax.value=gripLim.angMax;
      // Nilai driver dibaca dari firmware, bukan dari tebakan halaman: kalau
      // studio atau NVS mengubahnya, dropdown ini ikut benar tanpa reload.
      if(m.tmc_microstep!=null)document.getElementById("ms").value=m.tmc_microstep;
      if(m.tmc_spread!=null)document.getElementById("ch").value=m.tmc_spread;
    }else if(m.type==="ack"){
      // Ack gripper punya papan pesannya sendiri supaya tidak saling menimpa
      // dengan pesan microstep dan nada di kartu driver.
      if(m.cmd==="gripper"||m.cmd==="grip_limits"||m.cmd.indexOf("servo_")===0||m.cmd==="cal_save")
        gLapor(m.cmd+": "+(m.ok?"ok":"GAGAL")+(m.msg?" ("+m.msg+")":""));
      else lapor(m.cmd+": "+(m.ok?"ok":"GAGAL")+(m.msg?" ("+m.msg+")":""));
      // cal_set/grip_limits diterima berarti kalibrasi berubah, tarik lagi nilai
      // sebenarnya daripada berasumsi permintaan kita yang berlaku apa adanya.
      if((m.cmd==="cal_set"||m.cmd==="grip_limits"||m.cmd==="cal_zero")&&m.ok)
        kirim({cmd:"cal_get"});
      /* cal_zero menyetel target sendi itu jadi 0 DI FIRMWARE. Slider di sini
         wajib ikut, kalau tidak tgt[] masih menyimpan sudut lama dan goto
         berikutnya (dipicu slider sendi LAIN, karena goto selalu mengirim
         keenam sudut sekaligus) akan memerintahkan sendi yang baru saja
         di-nol-kan kembali ke sudut lamanya. Sendi baru selesai dipegang
         tangan, jadi itu justru saat paling buruk untuk gerakan tak terduga. */
      if(m.cmd==="cal_zero"&&m.ok){
        const sendi=(nolTertunda==null)?[0,1,2,3]:[nolTertunda];
        sendi.forEach(i=>{
          tgt[i]=0;
          document.getElementById("sl"+i).value=0;
          document.getElementById("tg"+i).textContent="0.0";
        });
      }
      if(m.cmd==="cal_zero")nolTertunda=null;
    }
  };
}

// Info di-poll berkala, bukan sekali saat load: status driver menjawab UART
// bisa berubah di tengah sesi (kabel kesenggol, VM mati), dan halaman yang
// menampilkan status basi lebih menyesatkan daripada tidak menampilkannya.
function muatInfo(){
 fetch("/api/info").then(r=>r.json()).then(d=>{
  info=d;
  document.getElementById("host").textContent=
    d.mode+" | "+d.ip+" | web port 80, WebSocket port "+d.ws_port;

  // Satu driver per sendi, jadi nomor pin memang milik sendi itu sendiri.
  for(let i=0;i<d.num_stepper;i++){
    document.getElementById("pin"+i).innerHTML=
      "STEP GPIO"+d.drv_step[i]+" DIR GPIO"+d.drv_dir[i]+
      (d.tmc_conn[i]===0?"":" <span class='warn'>driver bisu</span>");
  }
  // servo_pin sekarang 3 elemen (J5, J6, gripper) tetapi gripper BUKAN sendi
  // dan tidak punya baris "pinN": tanpa penjaga null di bawah, iterasi ketiga
  // melempar TypeError dan seluruh pembaruan halaman ini berhenti diam diam.
  for(let i=0;i<d.servo_pin.length;i++){
    const el=document.getElementById("pin"+(d.num_stepper+i));
    if(el)el.textContent="sinyal PWM GPIO"+d.servo_pin[i];
  }
  // Gripper punya kartunya sendiri, bukan baris sendi, jadi pinnya diisi
  // terpisah dari loop di atas.
  if(d.servo_pin.length>2)
    document.getElementById("gpin").textContent="sinyal PWM GPIO"+d.servo_pin[2];

  // Keempat sendi stepper punya drivernya sendiri, jadi semuanya bisa dibunyikan.
  const sj=document.getElementById("sj"), dipilih=sj.value;
  let opsi="";
  for(let i=0;i<d.num_stepper;i++)opsi+='<option value="'+(i+1)+'">J'+(i+1)+'</option>';
  if(sj.innerHTML!==opsi){
    sj.innerHTML=opsi;
    if(dipilih&&Number(dipilih)>=1&&Number(dipilih)<=d.num_stepper)sj.value=dipilih;
  }

  const baris=[
    ["J5 Wrist pitch (servo MG996R)","sinyal PWM <code>GPIO"+d.servo_pin[0]+"</code>, 50 Hz, pulsa "+d.servo_us[0]+" sampai "+d.servo_us[1]+" us"],
    ["J6 End roll (servo MG996R)","sinyal PWM <code>GPIO"+d.servo_pin[1]+"</code>, 50 Hz, pulsa "+d.servo_us[2]+" sampai "+d.servo_us[3]+" us"],
    ["Gripper (servo MG90S)","sinyal PWM <code>GPIO"+d.servo_pin[2]+"</code>, 50 Hz, pulsa "+d.servo_us[4]+" sampai "+d.servo_us[5]+" us (bukan DOF)"],
    ["Driver stepper (satu per sendi)",d.drv_step.map((s,i)=>
        "J"+(i+1)+": STEP <code>GPIO"+s+"</code> DIR <code>GPIO"+d.drv_dir[i]+"</code>").join("<br>")],
    ["ENABLE driver (bersama)","<code>GPIO"+d.en_pin+"</code>, active-LOW"],
    ["Bus UART TMC2209","<code>TX GPIO"+d.uart_tx+"</code> lewat resistor seri, <code>RX GPIO"+d.uart_rx+"</code>"],
    ["Driver menjawab UART",d.tmc_conn.map((c,i)=>"J"+(i+1)+": "+(c===0?"<span class='ok'>ya</span>":"<span class='warn'>tidak</span>")).join(" | ")],
    ["Bus I2C (AS5600 via mux)","<code>SDA GPIO"+d.i2c_sda+", SCL GPIO"+d.i2c_scl+"</code>"],
    ["Catu servo","terpisah 5 sampai 6 V, GND wajib common dengan ESP32"]];
  document.getElementById("info").innerHTML=
    baris.map(b=>"<tr><td>"+b[0]+"</td><td>"+b[1]+"</td></tr>").join("");
 }).catch(()=>{});
}

muatInfo();
setInterval(muatInfo,2000);
sambung();
</script></body></html>
)HTMLPAGE";
