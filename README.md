---
# 详细文档见https://modelscope.cn/docs/%E5%88%9B%E7%A9%BA%E9%97%B4%E5%8D%A1%E7%89%87
domain: #领域：cv/nlp/audio/multi-modal/AutoML
# - cv
tags: #自定义标签
-
datasets: #关联数据集
  evaluation:
  #- iic/ICDAR13_HCTR_Dataset
  test:
  #- iic/MTWI
  train:
  #- iic/SIBR
models: #关联模型
#- iic/ofa_ocr-recognition_general_base_zh

## 启动文件(若SDK为Gradio/Streamlit，默认为app.py, 若为Static HTML, 默认为index.html)
# deployspec:
#   entry_file: app.py
license: Apache License 2.0
---
#### 魔搭创空间部署说明
- 端口：7860（已暴露）
- 数据目录：`DATA_DIR` 默认为 `/home/user/app/data`（重启「从基础镜像开始」时会被清空）
- 环境变量（可选）：`DOUBAO_KEY` 豆包 API Key（未设置时使用内置默认值）

#### 数据备份到数据集（防止重启丢失，一键存储）
- **数据集**：[taoyao0498/Data_for_GAS](https://www.modelscope.cn/datasets/taoyao0498/Data_for_GAS)
- **原理**：创空间重启会清空容器内文件；魔搭「数据集」在平台侧持久保存。应用会把数据库复制到已 clone 的数据集目录并自动执行 `git add / commit / push`，无需找终端。
- **操作**：在创空间终端执行一次 <code>git clone https://www.modelscope.cn/datasets/taoyao0498/Data_for_GAS.git /home/user/app/Data_for_GAS</code>；管理后台 →「数据备份」→ 路径已预填为 <code>/home/user/app/Data_for_GAS</code> → 点击「一键存储到数据集」。
- **恢复**：新环境中 <code>git clone https://www.modelscope.cn/datasets/taoyao0498/Data_for_GAS.git /home/user/app/Data_for_GAS</code>，设置环境变量 <code>DATA_DIR=/home/user/app/Data_for_GAS</code> 后启动应用即可。

#### Clone with HTTP
```bash
 git clone https://www.modelscope.cn/studios/taoyao0498/Guidance_on_Application_and_streaming.git
```