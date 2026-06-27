# iPhone Mirror - AirPlay Receiver

App Electron nhận AirPlay mirroring từ iPhone/iPad để trình chiếu/quay màn hình iPhone trên PC Windows.

## Cách dùng nhanh

1. Chạy bản portable mới: `electron-app/dist-stable-window/iPhoneMirror.exe` hoặc file `iPhoneMirror.exe` đã copy ra Desktop.
2. Bấm **▶️ Khởi động AirPlay**.
3. Trên iPhone: mở Control Center → **Screen Mirroring/AirPlay** → chọn **iPhone Mirror**.
4. Khi iPhone kết nối, màn hình iPhone sẽ mở trong **một cửa sổ mirror riêng** của UxPlay/GStreamer.
5. Khi quay demo, quay cửa sổ mirror riêng đó. Không để iPhone quay lại đúng màn PC đang mirror để tránh vòng lặp hình gây lag/đơ.

## Bản sửa 2026-06-27 22:40: stable window mode

Bản trước cố nhúng native window của UxPlay/GStreamer vào Electron bằng Win32 `SetParent`. Trên Windows/GStreamer, hướng này dễ gây đen màn/kẹt render/đơ khi AirPlay đã bắt được nhưng video không vẽ ổn định.

Bản mới đổi sang hướng ổn định hơn:

- Electron chỉ làm **controller/log/status**.
- UxPlay/GStreamer giữ cửa sổ renderer riêng, không bị ép re-parent vào Electron.
- Trước khi start, app tự kill `uxplay.exe` cũ để tránh process treo giữ port/window.
- Có tùy chọn fullscreen (`-fs`) nếu anh bật trong UI.
- Package không còn đóng gói `window-embedder.ps1` vì không dùng nhúng nữa.
- UI/README đổi wording rõ: mirror mở ở cửa sổ riêng.

> Trade-off: giao diện không còn “nằm gọn trong khung iPhone” như mockup, nhưng ổn định hơn cho demo/quay màn hình. Nếu sau này cần khung đẹp, nên làm overlay/device-frame bằng OBS/capture window thay vì ép native window vào Electron.


## Bản sửa 2026-06-27 23:00: audio + iPhone frame overlay

Bản này bổ sung 2 điểm theo feedback test thật:

- **Âm thanh bật mặc định** qua Windows default output (`wasapisink`). Nếu không nghe tiếng, kiểm tra Windows Sound → Output device mặc định và Volume Mixer của app. Có thể bỏ tick âm thanh trong UI nếu chỉ cần hình mượt.
- **Khung iPhone overlay**: app mở thêm một cửa sổ trong suốt/always-on-top có viền iPhone, notch và home bar. Đặt/resize cửa sổ mirror của UxPlay nằm dưới overlay này để quay demo trông giống màn hình điện thoại, nhưng vẫn tránh nhúng native window vào Electron nên ổn định hơn.

Lưu ý: overlay không phải renderer video; nó là khung trang trí đặt lên trên cửa sổ mirror. Nếu cần bo góc video thật tuyệt đối thì nên dùng OBS crop/mask hoặc viết pipeline video riêng, không nên quay lại SetParent vì dễ kẹt render.

## Yêu cầu

- iPhone và PC cùng Wi-Fi.
- Bonjour/mDNS hoạt động (thường có nếu đã cài iTunes/Apple Bonjour).
- MSYS2 + GStreamer ở `C:\tools\msys64`.
- `uxplay.exe` đã build tại `uxplay-src/build/uxplay.exe`.

## Build

```powershell
cd electron-app
npm install

# Build portable vào thư mục mới, tránh lock dist cũ
npx electron-builder --win portable --config.directories.output=dist-stable-window
```

Nếu `npm run build` lỗi vì `dist/win-unpacked/resources/app.asar` bị Windows giữ lock, đóng app cũ hoặc build sang output mới như trên.

## File build đã verify

```text
electron-app/dist-stable-window/iPhoneMirror.exe
```

Đã chạy các check:

```powershell
node --check main.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package ok')"
npx electron-builder --win portable --config.directories.output=dist-stable-window
```

## Cấu trúc

```text
iphone-mirror/
├── uxplay-src/      # UxPlay AirPlay receiver
├── electron-app/    # Electron controller UI
│   ├── main.js      # Main process + start/stop UxPlay stable-window mode
│   ├── preload.js   # IPC bridge
│   ├── index.html   # UI + logs/status
│   └── package.json
└── README.md
```

## Test nhanh cho anh

1. Tắt AirPlay trên iPhone.
2. Đóng app iPhone Mirror cũ nếu đang mở.
3. Mở Task Manager, kill `uxplay.exe` nếu còn.
4. Chạy `iPhoneMirror.exe` bản mới.
5. Bấm **Khởi động AirPlay**.
6. iPhone cùng Wi-Fi → Screen Mirroring → chọn **iPhone Mirror**.
7. Nếu cửa sổ mirror nằm sau app, bấm `Alt+Tab` hoặc thu nhỏ cửa sổ controller.

## Use case

- Quay video demo app mobile cho khóa học.
- Trình chiếu màn hình iPhone lên monitor/projector.
- Dùng như AirPlay receiver nhẹ trên Windows.
