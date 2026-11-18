# 引擎目录（需自行下载）

本程序的主识别引擎是 **RapidOCR-json v0.2.0**（PaddleOCR PP-OCRv4 模型，ONNX 离线推理，约 70MB），
因体积较大不放入代码仓库，需单独下载。

## 一键安装（推荐）

```bash
npm run setup
```

脚本会自动下载引擎包并用内置 7zr 解压到本目录。

## 手动安装

1. 下载：https://github.com/hiroi-sora/RapidOCR-json/releases/download/v0.2.0/RapidOCR-json_v0.2.0.7z
   （国内网络慢可用镜像，或自行搜索 RapidOCR-json v0.2.0）
2. 用 7-Zip 解压，得到 `RapidOCR-json_v0.2.0/` 文件夹
3. 把该文件夹放到本 `engine/` 目录下，最终结构为：

```
engine/
└── RapidOCR-json_v0.2.0/
    ├── RapidOCR-json.exe
    ├── models/
    └── ...
```

## 不装引擎也能用

`engine/` 缺失时程序会自动回退到 Tesseract.js 兜底引擎（速度慢一些、准确率低一些），
功能不受影响。安装引擎后可获得 0.6~1 秒/张的识别速度。
