# 第三方组件与许可声明（Third-Party Notices）

本项目整体以 **GNU General Public License v3.0 or later**（见根目录 `LICENSE`）发布。
下列第三方组件随插件一起分发（已内联进 `ui/` 产物或 `bin/` 后端可执行文件），
其原始许可证与版权声明一并保留在此。

## 运行时依赖（打包进 `.dbxp`）

| 组件 | 版本 | 许可证 | 用途 | 上游 |
| --- | --- | --- | --- | --- |
| pdfjs-dist（PDF.js） | 4.10.38 | Apache-2.0 | PDF 解析与渲染；CMap / 标准字体数据以 base64 内联 | https://github.com/mozilla/pdf.js |
| JSZip | 3.10.2 | MIT 或 GPL-3.0-or-later（本项目按 GPL-3.0-or-later 使用） | EPUB / CBZ / DOCX 的 ZIP 解包 | https://github.com/Stuk/jszip |
| Vue | 3.5.x | MIT | 前端框架 | https://github.com/vuejs/core |
| DBX Go Plugin SDK（内联副本） | 随 CLI 0.1.9 | Apache-2.0 | Sidecar 的 JSON-RPC 协议与握手实现，位于 `backend/internal/dbxpluginsdk/` | https://github.com/t8y2/dbx |

## 构建期依赖（不随包分发）

vite、@vitejs/plugin-vue、typescript、vue-tsc、@types/node、playwright-core（仅测试用）均为 MIT 或 Apache-2.0，
仅用于构建与测试，不进入 `.dbxp`。

## 字体与字符映射数据

`src/assets/pdfjs/pdfjs-data.generated.ts` 内的 CMap（`.bcmap`）与标准字体数据（Foxit `.pfb`）
来自 pdfjs-dist 包，遵循其 Apache-2.0 许可（其中标准字体数据的原始授权见 PDF.js 仓库 `LICENSE` 说明）。

## 声明保留方式

- Apache-2.0 组件（PDF.js、DBX Go Plugin SDK）：保留其许可证与版权声明，本项目不对其主张额外限制。
- MIT 组件（JSZip、Vue）：保留其版权与许可声明。
- 各组件许可证全文已随包分发，位于 `licenses/`，与组件对照关系见 `licenses/README.md`：

  | 文件 | 内容 |
  | --- | --- |
  | `licenses/GPL-3.0.txt` | 本项目许可（同包根 `LICENSE`） |
  | `licenses/Apache-2.0.txt` | Apache-2.0 规范全文 |
  | `licenses/MIT.txt` | MIT 规范全文 |
  | `licenses/pdfjs-Apache-2.0.txt` | PDF.js 上游许可原文（含 Mozilla 版权） |
  | `licenses/foxit-standard-fonts.txt` | Foxit 标准字体数据原始授权 |
  | `licenses/dbx-go-sdk-Apache-2.0.txt` | DBX Go Plugin SDK 声明与出处 |
  | `licenses/jszip-MIT.txt` | JSZip 上游许可原文（MIT / GPLv3 双许可） |
  | `licenses/vue-MIT.txt` | Vue 上游许可原文 |

> 说明：GPL-3.0 与本项目所依赖的 Apache-2.0 / MIT 组件兼容；JSZip 采用「MIT 或 GPL-3.0-or-later」双许可，
> 本项目按 GPL-3.0-or-later 一侧使用。
