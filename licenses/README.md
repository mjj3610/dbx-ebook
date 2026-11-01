# 第三方组件与许可文本

本插件（`com.mjj3610.ebook`）以 **GPL-3.0-or-later** 发布，全文见包内 `LICENSE`
（同 `licenses/GPL-3.0.txt`）。以下组件随二进制一起分发，其许可证副本随包提供：

| 组件 | 用途 | 许可证 | 版权声明 | 全文 |
| --- | --- | --- | --- | --- |
| 本项目 dbx-ebook | 插件本体 | GPL-3.0-or-later | © mjj3610 | `licenses/GPL-3.0.txt` |
| PDF.js (pdfjs-dist 4.10.38) | PDF 渲染 | Apache-2.0 | © Mozilla Foundation | `licenses/pdfjs-Apache-2.0.txt`、`licenses/Apache-2.0.txt` |
| Foxit 标准字体数据 | PDF 标准 14 字体 | Foxit 原始授权（随 PDF.js 分发） | © Foxit Software | `licenses/foxit-standard-fonts.txt` |
| DBX Go Plugin SDK | 原生 Sidecar 的 JSON-RPC 框架（内联副本） | Apache-2.0 | © DBX project authors | `licenses/dbx-go-sdk-Apache-2.0.txt`、`licenses/Apache-2.0.txt` |
| JSZip 3.x | EPUB / EPUB 资源解包 | MIT 或 GPL-3.0-or-later（本项目按后者使用） | © Stuart Knightley, David Duponchel | `licenses/jszip-MIT.txt`、`licenses/MIT.txt` |
| Vue 3 | 前端运行时 | MIT | © Yuxi (Evan) You | `licenses/vue-MIT.txt`、`licenses/MIT.txt` |

## 打包说明

- `dbx-plugin.toml` 的 `[package] include` 已包含 `LICENSE`、`THIRD-PARTY-NOTICES.md` 与 `licenses/`，
  因此这些文本会随 `.dbxp` 一起分发，并计入包内 `checksums.json`。
- 升级任何依赖时，请同步更新本表与 `licenses/` 下的对应文本：
  - PDF.js / Foxit 字体：`node_modules/pdfjs-dist/LICENSE`、`node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT`
  - JSZip：`node_modules/jszip/LICENSE.markdown`
  - Vue：`node_modules/vue/LICENSE`
  - DBX Go SDK：`@dbx-app/plugin-cli` 内的 `plugins/sdk/go/dbx-plugin-sdk`
