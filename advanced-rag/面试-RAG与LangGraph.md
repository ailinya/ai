# Advanced-RAG 目录 · 技术面试提纲

本文基于仓库 `advanced-rag/` 下的实现整理，对应源码：`naive-rag.mjs`、`rag-query-router.mjs`、`rag-multihop.mjs`、`rag-webfallback.mjs`。适合作为 **RAG、向量检索、LangGraph 编排、生产化网络调用** 等方向的面试准备与自述材料。

---

## 一、项目速览（30 秒自我介绍）

| 文件 | 核心能力 |
|------|----------|
| `naive-rag.mjs` | 最简 LangGraph：**检索 → 生成**，Milvus 向量库 + DashScope 兼容 OpenAI API |
| `rag-query-router.mjs` | **查询路由**：LLM 判定 direct / retrieve，**按需连接 Milvus**，减少简单问题的延迟与依赖 |
| `rag-multihop.mjs` | **多跳检索**：路由含 multihop → 子问题拆解 → 顺序检索与规划下一步 → 汇总生成；可限 `MAX_RETRIEVALS` |
| `rag-webfallback.mjs` | **本地 RAG + 联网兜底**：问题路由、本地检索、**上下文充分性评估**、Bocha 搜索、失败降级；undici/代理/IPv4/重试 |

技术栈要点：**LangChain JS（OpenAI 兼容客户端 + Embeddings）**、**LangGraph（StateGraph、Annotation、条件边）**、**Milvus（HNSW + COSINE）**、**Zod 结构化输出**、**undici + 可选 HTTPS 代理**。

---

## 二、基础概念题

### 1. 什么是 RAG？和微调相比各适合什么场景？

**答：** RAG（Retrieval-Augmented Generation）在生成前从外部知识库检索相关片段，再拼进 Prompt。适合知识更新频繁、需要可溯源引用、训练数据不足或不想为每类知识单独微调的场景。微调更适合风格固定、行为边界强、且数据可集中标注的任务。本目录是典型 **文档型 RAG**（小说切片 + 向量库）。

### 2. LangGraph 在本项目里解决什么问题？

**答：** 把「路由 → 检索（可能多步）→ 评估 → 联网 → 再评估 → 生成」拆成**有状态节点**与**条件边**，比单段 Chain 更易表达分支、循环（多跳）和失败降级。状态用 `Annotation.Root` 定义字段，节点返回部分 state 更新，图负责合并与调度。

### 3. `Annotation` 里 `reducer: (_prev, next) => next` 表示什么？

**答：** 多节点写入同一字段时的合并策略。这里用 `next` 覆盖 `prev`，等价于「该字段以最后一次写入为准」。若要做列表追加，可改为自定义 reducer（例如拼接数组）。面试时可对比 **覆盖型** 与 **累积型** 状态设计。

### 4. Milvus 里 HNSW + COSINE 大致在做什么？

**答：** 向量用 **余弦相似度** 衡量语义相近程度；**HNSW** 是近似最近邻图索引，在速度与召回之间折中。`efConstruction` / `ef` 影响建索引与查询时的图遍历范围，一般 **ef 越大召回越好、延迟越高**。本项目中 `indexSearchParams` 与 `indexCreateOptions` 需与建库时一致，否则检索行为可能不符合预期。

### 5. 为什么用 `withStructuredOutput` + Zod？

**答：** 让模型输出 **合法 JSON 且符合 Schema**（如 `strategy: enum`），便于程序做 `addConditionalEdges` 的分支，减少自由文本解析失败。`rag-query-router` / `rag-multihop` / `rag-webfallback` 的路由与评估都依赖结构化输出。

---

## 三、与目录代码强相关的深度题

### 6. `rag-query-router` 里 `ensureVectorStore` 的设计意图？

**答：** **延迟连接**：只有 `strategy === retrieve` 时才连 Milvus 并 `loadCollection`，避免简单问题也等待向量库 IO。面试可延伸：**冷启动优化**、**连接池/单例**、**路由误判时的降级**（本文件路由失败时默认走 `retrieve` 更稳妥）。

### 7. `rag-multihop` 的多跳和单次检索的本质区别？

**答：** 单次检索假设「一次 embedding 搜索」能覆盖答案所需证据；多跳适用于 **依赖链**（先确认 A 再查 B）。实现上通过 **子问题分解**（`DecompositionSchema`）、**逐跳检索**（`hopResults`）、**下一步规划**（`NextStepSchema`：`retrieve` | `generate`）和 **`retrievalCount` / `maxRetrievals` 上限** 防止无限循环。可追问：如何避免子问题过碎或过泛？（Prompt 约束、最大子问题数、合并生成时的上下文窗口。）

### 8. `rag-webfallback` 的图流程如何向面试官画清楚？

**答：** 简图：`START → route_question` →（simple）`direct_answer → END`；（complex）`local_retrieve → evaluate_local` → 若已有 `webContext` 或评估 `enough` → `generate`；否则 `web_search → evaluate_local`（二次评估）→ `generate`。关键点：**评估节点**决定要不要联网；**联网失败后占位 `webContext`**，图不崩溃，后续生成依赖本地上下文并提示模型勿编造外链信息。

### 9. Bocha 请求为什么用 undici + `ProxyAgent` + `dns.setDefaultResultOrder('ipv4first')`？

**答：** Node 全局 `fetch` 在部分 Windows/网络环境下易出现 **IPv6 优先但链路不通**、**需系统代理才能出网** 等问题。undici 的 `ProxyAgent` 在设置 `HTTPS_PROXY`/`HTTP_PROXY` 时可显式走代理；**每次重试新建 `AbortSignal.timeout`**，避免超时信号一次性耗尽；**重试**缓解瞬时网络失败。面试可联系：**可观测性**（`BOCHA_DEBUG_PROXY`）、**与业务降级**（try/catch 占位上下文）的分层。

### 10. 「上下文充分性评估」在 RAG 体系里属于哪一类模式？

**答：** 接近 **Self-RAG / CRAG** 思路的简化版：用 LLM 判断 `enough` 与 `missing`，必要时产出 `web_query` 再触发工具（联网搜索）。可讨论：**评估成本**（多一次 LLM 调用）、**评估本身幻觉**（可结合分数阈值、重排序）、与 **固定 always-retrieve** 的取舍。

---

## 四、场景与开放题（考察系统设计）

### 11. 若 Milvus 宕机，你会如何改造当前图？

**答：** 检索节点 catch 后写入空文档 + 标记 `retrieval_error`；路由或生成节点根据标记选择：**仅 LLM 常识回答并免责声明**、**切换备库**、或 **rag-webfallback 式走联网**。与现有「联网失败占位」对称设计。

### 12. 如何降低向量检索的幻觉（模型看了错误片段仍瞎编）？

**答：** **重排序（Reranker）**、**相似度阈值过滤**、**Prompt 强制「片段未提及则答不知道」**、**引用编号约束**、**多跳拆分复杂问句**。本仓库生成 Prompt 中已有「不要编造」类约束，可结合业务加强。

### 13. 多跳检索的终止条件还可以有哪些？

**答：** 除 `maxRetrievals` 外：**token 预算**、**子问题队列空**、**连续两轮检索无新文档**、**规划模型连续两次选择 generate**、**用户超时**。说明工程上需要 **硬上限 + 语义终止** 双保险。

---

## 五、推荐自述结构（面试现场 2～3 分钟）

1. **业务**：面向《天龙八部》电子书场景的问答，Milvus 存 chunk 向量。  
2. **演进**：从线性 RAG → 路由省资源 → 多跳解决组合依赖 → 评估 + 联网补影视/外链类知识。  
3. **工程**：Zod 结构化路由；按需连库；LangGraph 条件边；联网侧 undici、代理、IPv4、重试与 **失败不崩图**。  
4. **你愿意深入的方向**：索引与召回、图编排、或 LLM 评测与成本。

---

## 六、环境与运行（面试官问「怎么跑」时）

- 依赖见 `package.json`：`@langchain/*`、`@zilliz/milvus2-sdk-node`、`undici`、`zod`、`dotenv`。  
- 典型环境变量：`DASHSCOPE_API_KEY`、`OPENAI_BASE_URL`、`MODEL_NAME`、`EMBEDDINGS_MODEL_NAME`；联网示例需 `BOCHA_API_KEY`；代理可选 `HTTPS_PROXY`。  
- Milvus 集合名示例：`ebook_collection`，需与本机 Milvus 及前置入库流程一致。

---

*文档生成依据：`advanced-rag/src` 下各 `.mjs` 的职责注释与图结构；若源码变更，请同步更新本节与「速览」表。*
