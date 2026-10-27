# ICU Atlas

ICU 患者数据智能可视化分析系统，面向 MIMIC-IV 3.1 的研究前数据探索与课程展示。

本仓库仅提供应用源码、数据构建与验证脚本和数据字典。原始数据、分析数据库、病例导出、页面截图、API 密钥和论文草稿均不包含在内。克隆仓库后需要在具有数据访问权限的本地环境中准备数据并构建数据库，才能启动应用。

## 功能

- 数据总览：入住次数、患者人数、医院住院次数及年龄、性别、ICU 类型和停留时长分布。
- 群体探索：统一筛选、多视图联动、热力图、箱线图、散点图和记录下钻。
- A/B 对比：保存两组筛选条件，以全量匹配记录比较中位数、四分位区间及共同入住和共同患者数量。
- 案例搜索：按完整编号或 ICU 类型、入院类型的中英文关键词查询，支持排序和分页。
- 入住详情：阶段时间线、生命体征曲线、时间刷选、共享悬停、缺测条带与时间桶覆盖率。
- 数据分析助手：依据后端聚合统计进行图文回答、连续追问与自然语言筛选建议；条件预览后点击应用，支持撤销最近一次助手筛选。

## 环境

核心应用使用 Python 3.9+ 标准库、SQLite 和本地 HTML/CSS/JavaScript，无需安装第三方运行依赖。浏览器需要支持 SVG、Canvas 与 localStorage。前端离线检查脚本另外需要 Node.js。

## 准备数据

数据来源：[PhysioNet MIMIC-IV 3.1](https://physionet.org/content/mimiciv/3.1/)。数据访问与使用遵循该数据集的授权要求。获得访问权限后，在本地准备以下文件，保留原始压缩格式：

```text
mimiciv/3.1/
├── SHA256SUMS.txt
├── hosp/
│   ├── patients.csv.gz
│   └── admissions.csv.gz
└── icu/
    ├── icustays.csv.gz
    ├── d_items.csv.gz
    └── chartevents.csv.gz
```

校验文件并构建数据库：

```bash
python3 scripts/verify_sources.py
python3 scripts/build_database.py
```

默认生成 `data/icu_analysis.sqlite` 和 `reports/` 下的数据准备报告。生命体征原始事件较多，构建耗时取决于本机与磁盘。已有数据库不会覆盖，重新构建可指定其他路径：

```bash
python3 scripts/build_database.py --database data/icu_analysis_v2.sqlite
```

应用默认读取 `data/icu_analysis.sqlite`，启动时检查生命体征提取是否完成。不要将 `--core-only` 生成的未完成数据库直接用于应用。原始数据保持不变，应用以只读方式访问分析数据库。

## 启动

```bash
python3 app/server.py
```

打开 [本地应用](http://127.0.0.1:8765)。也可使用 `python3 app/server.py --port 8766` 指定端口，按 Ctrl+C 停止服务。

## 可选的 DeepSeek 助手

将 `.env.example` 复制为 `.env`，在本地填写 `DEEPSEEK_API_KEY`，保留或按需设置 `DEEPSEEK_MODEL`。密钥只由服务端读取，不应提交到 GitHub。未配置密钥时，本地图表、筛选、检索与详情功能仍可使用。

助手请求包含当前队列的聚合统计、问题及近期对话；自动统计载荷排除原始测量、日期、病例标识与搜索原文。用户问题仍会发送至模型，因此不要在问题中填写个人隐私或凭据。模型只提出限定字段的筛选建议，不能执行任意 SQL 或代码；预览和应用结果由本地数据库查询确定。

## 验证

无需数据库或外部模型调用的模型接口与前端逻辑检查：

```bash
python3 scripts/verify_summary.py
node scripts/verify_analysis_tools.cjs
node scripts/verify_filter_actions.cjs
node scripts/verify_chat_charts.cjs
```

准备数据库后运行：

```bash
python3 scripts/verify_database.py
python3 scripts/verify_app.py
python3 scripts/verify_analysis_tools.py
python3 scripts/verify_case_search.py
python3 scripts/verify_filter_actions.py
```

这些检查验证实现的一致性，不代表已完成用户效率实验或真实模型回答准确率评价。

## 目录

- `app/`：HTTP 服务、统计和筛选逻辑、模型接口及前端资源。
- `scripts/`：数据构建、文档导出和验证脚本。
- `reports/数据字典.md`：数据库对象、字段及统计定义。
- `项目题目与实验目的.md`：课程项目目标与拟评价指标。

## 统计与展示边界

一次 ICU 入住以 `stay_id` 为分析单位，患者和医院住院分别按 `subject_id`、`hadm_id` 去重。停留时长筛选下限包含、上限不包含。指标卡与分布使用全部匹配记录，散点图最多绘制 1,200 个确定性等间隔抽取点。曲线按共同时间桶聚合，缺测不插补、不连线；时间桶有记录不等同于持续监测。A/B 差异为描述性比较，未调整混杂因素。系统用于研究前探索与教学，不用于临床诊断或实时监护。
