# Build MirrorBeam

## Yêu cầu

- Node.js 20+ và npm
- MSYS2 (UCRT64) tại `C:\tools\msys64` với GStreamer: `pacman -S mingw-w64-ucrt-x86_64-gstreamer mingw-w64-ucrt-x86_64-gst-plugins-{base,good,bad} mingw-w64-ucrt-x86_64-gst-libav mingw-w64-ucrt-x86_64-openh264`
- Apple Bonjour (dịch vụ chạy trên máy dev): cài Bonjour Print Services từ https://support.apple.com/kb/DL999

## uxplay.exe (đã build sẵn tại `../uxplay-src/build/uxplay.exe`)

Source đầy đủ (kèm patch xoay hình runtime qua stdin — GPL-3.0) ở `../uxplay-src/src`.
Build lại trong shell MSYS2 UCRT64:

```bash
pacman -S mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,libplist,openssl}
export BONJOUR_SDK_HOME='C:\BonjourSDK'   # chứa Include/dns_sd.h + Lib/x64/dnssd.lib
cd uxplay-src/src
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_DNS_SD=1 -DNO_MARCH_NATIVE=ON
cmake --build build -j4
cp build/uxplay.exe ../build/uxplay.exe
```

`C:\BonjourSDK`: tải `dns_sd.h` từ https://github.com/apple-oss-distributions/mDNSResponder
(mDNSShared/dns_sd.h) vào `Include/`, và dùng import lib `libdnssd.a` (repo gốc) đổi tên
thành `Lib/x64/dnssd.lib`.

## Thư mục `gstreamer/` (bundle runtime, không commit vào git)

Tạo bằng script tính dependency closure — chạy trong MSYS2 UCRT64:
xem `scripts/make-bundle.sh` (copy DLL cần thiết + 18 plugin vào `gstreamer/bin` và `gstreamer/plugins`).

## Thư mục `redist/` (không commit vào git)

Tải Bonjour64.msi (trích từ gói Bonjour Print Services của Apple) và đặt vào `redist/Bonjour64.msi`.
Chỉ dùng cho bản NSIS; bản Store không bundle.

## Build installer

```bash
npm install
npm run build          # NSIS installer  -> dist/MirrorBeam-Setup-x.y.z.exe
npm run build:store    # Microsoft Store -> dist-store/MirrorBeam x.y.z.appx
```

Phát hành auto-update: tăng `version` trong package.json, build NSIS, tạo GitHub Release
tag `vx.y.z` và upload `MirrorBeam-Setup-x.y.z.exe`, `.blockmap`, `latest.yml`.
