# 第三方组件与许可声明

本项目自身代码以 [MIT](LICENSE) 许可发布。下列第三方组件随本项目分发或运行时下载，其版权与许可归各自作者所有：

| 组件 | 版本 | 用途 | 许可 |
|---|---|---|---|
| [RapidOCR-json](https://github.com/hiroi-sora/RapidOCR-json) | v0.2.0 | 主 OCR 引擎（命令行调用，输出 JSON） | MIT |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv4 模型 | — | RapidOCR-json 内置的检测 / 识别模型 | Apache-2.0 |
| [RapidOCR / RapidOcrOnnx](https://github.com/RapidAI/RapidOCR) | — | ONNX 推理封装 | Apache-2.0 |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | v6 | 兜底 OCR 引擎 | Apache-2.0 |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) 语言数据 | tessdata_fast | `eng` / `chi_sim` 模型 | Apache-2.0 |
| [Jimp](https://github.com/jimp-dev/jimp) | v1 | 图像裁剪 / 缩放 / 灰度 | MIT |
| [Express](https://github.com/expressjs/express) | v4 | 本地 HTTP 服务 | MIT |
| [7-Zip (7zr.exe)](https://www.7-zip.org/) | 24.x | 仅用于 `npm run setup` 解压引擎包 | LGPL-2.1 |
| [Node.js 运行时](https://nodejs.org/) | v22 LTS | 「完整包」内嵌的 `runtime/node.exe`，免安装即可运行 | MIT |

## 说明

- 本项目不修改上述二进制文件，仅以命令行方式调用。
- `engine/` 下的引擎与模型不随仓库分发，由用户通过 `npm run setup` 自行下载；下载即表示同意对应项目的许可条款。
- `runtime/node.exe` 仅出现在 Release 的「完整包」附件中（仓库不含该二进制），其许可证全文见包内 `runtime/LICENSE-node.txt`。
- 若你是上述项目的作者且不希望被引用，请提交 Issue，我们会移除相关引用。
