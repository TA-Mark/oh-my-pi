# Quy trình đồng bộ upstream (OMP)

Tài liệu này mô tả cách giữ fork `TA-Mark/oh-my-pi` (chứa desktop app) luôn cập nhật
với upstream `can1357/oh-my-pi`, đồng thời giảm thiểu xung đột khi merge.

## 1. Bối cảnh remote

| Remote     | URL                                      | Vai trò                                  |
| ---------- | ---------------------------------------- | ---------------------------------------- |
| `origin`   | `https://github.com/TA-Mark/oh-my-pi`    | Fork của bạn — nơi chứa `packages/desktop` |
| `upstream` | `https://github.com/can1357/oh-my-pi`    | Nguồn gốc OMP — chỉ đọc, không push       |

Thiết lập (đã thực hiện):

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream main --no-tags
```

**Trạng thái tại thời điểm lập tài liệu:** `main` của fork ở mức `0 ahead / 396 behind`
so với `upstream/main`. Tức là `main` chưa có commit riêng nào → có thể fast-forward sạch
về upstream bất cứ lúc nào. Hãy giữ nguyên tính chất này: **không commit trực tiếp vào `main`.**

## 2. Mô hình nhánh

```
upstream/main ──────────────►  (nguồn gốc, thay đổi liên tục)
        │ fast-forward
        ▼
     main  ──────────────────►  (bản sao sạch của upstream, KHÔNG commit tay)
        │ merge định kỳ
        ▼
  CustomDesktop ──────────────►  (nhánh tích hợp: main + toàn bộ packages/desktop)
        │ nhánh tính năng
        ▼
  feat/desktop-*  ────────────►  (mỗi tính năng desktop một nhánh nhỏ)
```

Nguyên tắc:

- **`main`**: luôn là ảnh phản chiếu của `upstream/main`. Chỉ cập nhật bằng fast-forward.
- **`CustomDesktop`**: nhánh tích hợp. Toàn bộ code desktop sống ở đây, merge `main` vào định kỳ.
- **`feat/desktop-*`**: nhánh làm việc từng tính năng, merge ngược về `CustomDesktop`.

## 3. Quy trình sync định kỳ

Chạy mỗi khi muốn kéo cập nhật từ OMP gốc:

```sh
# 1. Lấy cập nhật upstream
git fetch upstream main --no-tags

# 2. Fast-forward main (không tạo merge commit vì main không có commit riêng)
git switch main
git merge --ff-only upstream/main
git push origin main            # đẩy main đã cập nhật lên fork

# 3. Đưa cập nhật vào nhánh tích hợp desktop
git switch CustomDesktop
git merge main                  # hoặc: git rebase main (xem mục 5)

# 4. Kiểm tra build/test sau merge (xem mục 6)
```

Nếu `merge --ff-only` báo lỗi (main đã lỡ có commit riêng), xử lý theo mục 7.

## 4. Nguyên tắc "additive" để giảm xung đột

Xung đột merge tỉ lệ thuận với số dòng ở lõi bị fork sửa. Vì vậy:

1. **Cô lập trong `packages/desktop/`.** Gần như 100% code desktop nằm trong package này.
   Upstream không đụng tới thư mục đó → không xung đột.
2. **Không sửa lõi trừ khi bắt buộc.** Nếu buộc phải chạm file ngoài `packages/desktop`
   (ví dụ thêm entry vào workspace), giữ thay đổi nhỏ nhất có thể và ghi lại trong
   `packages/desktop/docs/core-touchpoints.md` để dễ rà lại sau mỗi lần sync.
3. **Giao tiếp qua protocol, không import sâu.** Desktop nói chuyện với engine qua
   RPC mode (`omp --mode rpc-ui`) và `@oh-my-pi/pi-wire`, không import trực tiếp module
   nội bộ của `coding-agent`. Đây là ranh giới ổn định nhất trước thay đổi upstream.

Các điểm chạm lõi hiện tại cần theo dõi:

- `package.json` gốc: `packages/desktop` tự động nằm trong `workspaces: ["packages/*"]`,
  nên **không cần** sửa file này. Nếu thêm script tiện ích (vd `desktop:dev`) thì đó là
  điểm chạm lõi duy nhất — ghi vào `core-touchpoints.md`.
- `bunfig.toml`, `biome.json`, `tsconfig`: chỉ sửa nếu thật sự cần; ưu tiên cấu hình
  cục bộ trong `packages/desktop/`.

## 5. Merge hay rebase `CustomDesktop`?

- **Merge (khuyến nghị mặc định):** `git merge main`. An toàn, giữ nguyên lịch sử, dễ xử lý
  xung đột một lần. Phù hợp khi `CustomDesktop` đã được chia sẻ/đẩy lên `origin`.
- **Rebase:** `git rebase main`. Lịch sử tuyến tính, đẹp hơn, nhưng viết lại commit →
  **chỉ dùng khi `CustomDesktop` chưa chia sẻ với người khác** (cần force-push sau đó).

Vì `CustomDesktop` đã có trên `origin`, mặc định dùng **merge**.

## 6. Kiểm tra sau mỗi lần sync

```sh
bun install                     # cập nhật dependency theo lockfile mới của upstream
bun run build:native            # build lại native addon nếu crate Rust đổi
bun check                       # type-check toàn workspace (KHÔNG dùng tsc)

# Riêng desktop
bun --cwd=packages/desktop run check
bun --cwd=packages/desktop run test
```

Đặc biệt chú ý **breaking change ở RPC protocol**: nếu `packages/coding-agent/src/modes/rpc/rpc-types.ts`
thay đổi, type mirror ở frontend desktop sẽ báo lỗi build (xem mục 7 của design doc). Đó là
lá chắn chính chống "drift" âm thầm.

## 7. Xử lý sự cố

- **`merge --ff-only` thất bại trên `main`:** ai đó đã commit vào `main`. Chuyển các commit
  đó sang `CustomDesktop` (`git cherry-pick`) rồi reset `main` về `upstream/main`:
  ```sh
  git switch main
  git reset --hard upstream/main    # CHỈ khi chắc chắn không mất việc quan trọng
  ```
- **Xung đột trong `packages/desktop`:** hiếm, chỉ xảy ra nếu bạn tự sửa cùng file trên nhiều
  nhánh. Giải quyết thủ công, ưu tiên bản `CustomDesktop`.
- **Xung đột ngoài `packages/desktop`:** dấu hiệu đã vi phạm nguyên tắc additive. Xem lại
  `core-touchpoints.md`, cân nhắc chuyển thay đổi vào trong package desktop.

## 8. Tần suất đề xuất

- Sync `main` từ upstream: **hàng tuần** hoặc trước mỗi đợt phát triển desktop lớn.
- Merge `main` vào `CustomDesktop`: ngay sau mỗi lần sync `main`, khi cây làm việc sạch.
