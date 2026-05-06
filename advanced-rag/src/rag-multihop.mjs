import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { z } from "zod";

// 这个文件在 rag-query-router 的基础上增加了多跳检索能力：
// 对于需要先查 A、再查 B 才能回答的问题，先拆分子问题，再按顺序检索，最后综合生成答案。

const TOP_K = 5;
const COLLECTION_NAME = "ebook_collection";
// 多跳检索最大轮数：可用环境变量 MAX_RETRIEVALS 覆盖；命令行第 4 个参数优先级更高
const _envMaxR = Number(process.env.MAX_RETRIEVALS);
const DEFAULT_MAX_RETRIEVALS =
  Number.isFinite(_envMaxR) && _envMaxR >= 1 ? Math.floor(_envMaxR) : 6;

// ─────────────────────────────────────────────
// 图状态定义
// ─────────────────────────────────────────────
const StateAnnotation = Annotation.Root({
  question: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  k: Annotation({
    reducer: (_prev, next) => next,
    default: () => TOP_K,
  }),
  strategy: Annotation({
    reducer: (_prev, next) => next,
    default: () => "retrieve",
  }),
  routeReason: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  subQuestions: Annotation({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  nextSubIdx: Annotation({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  retrievalCount: Annotation({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  maxRetrievals: Annotation({
    reducer: (_prev, next) => next,
    default: () => DEFAULT_MAX_RETRIEVALS,
  }),
  plannedNext: Annotation({
    reducer: (_prev, next) => next,
    default: () => "generate",
  }),
  hopResults: Annotation({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  documents: Annotation({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  answer: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

// ─────────────────────────────────────────────
// 初始化模型和 Embeddings
// ─────────────────────────────────────────────
const llm = new ChatOpenAI({
  model: process.env.MODEL_NAME,
  apiKey: process.env.DASHSCOPE_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  temperature: 0,
});

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.DASHSCOPE_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  dimensions: 1024,
});

const RouterSchema = z.object({
  strategy: z.enum(["direct", "retrieve", "multihop"]),
  reason: z.string(),
});

const DecompositionSchema = z.object({
  subQuestions: z.array(z.string()).min(2).max(4),
  reasoning: z.string(),
});

const RewriteSchema = z.object({
  standaloneQuestion: z.string(),
});

const NextStepSchema = z.object({
  nextAction: z.enum(["retrieve", "generate"]),
  reason: z.string(),
});

const routerModel = llm.withStructuredOutput(RouterSchema);
const decompositionModel = llm.withStructuredOutput(DecompositionSchema);
const rewriteModel = llm.withStructuredOutput(RewriteSchema);
const nextStepModel = llm.withStructuredOutput(NextStepSchema);

let vectorStore;

// 只在真正需要检索时才连接向量库，避免简单问题也等待 Milvus。
async function ensureVectorStore() {
  if (vectorStore) {
    return vectorStore;
  }

  console.log("连接到 Milvus...");
  vectorStore = await Milvus.fromExistingCollection(embeddings, {
    collectionName: COLLECTION_NAME,
    url: "localhost:19530",
    textField: "content",
    primaryField: "id",
    vectorField: "vector",
    indexCreateOptions: {
      metric_type: "COSINE",
      index_type: "HNSW",
      params: { M: 16, efConstruction: 200 },
      search_params: { ef: 64 },
    },
  });
  vectorStore.indexSearchParams = {
    metric_type: "COSINE",
    params: JSON.stringify({ ef: 64 }),
  };
  console.log("✓ 已连接\n");

  try {
    await vectorStore.client.loadCollection({ collection_name: COLLECTION_NAME });
    console.log(`✓ 集合 ${COLLECTION_NAME} 已加载\n`);
  } catch (error) {
    if (!error.message.includes("already loaded")) {
      throw error;
    }
    console.log(`✓ 集合 ${COLLECTION_NAME} 已处于加载状态\n`);
  }

  return vectorStore;
}

async function retrieveRelevantContent(question, k = TOP_K) {
  try {
    const store = await ensureVectorStore();
    const docsWithScores = await store.similaritySearchWithScore(question, k);

    return docsWithScores.map(([doc, score]) => ({
      score,
      content: doc.pageContent,
      id: doc.metadata?.id ?? "unknown",
      book_id: doc.metadata?.book_id ?? "未知",
      chapter_num: doc.metadata?.chapter_num ?? "未知",
      index: doc.metadata?.index ?? "未知",
    }));
  } catch (error) {
    console.error("检索内容时出错:", error.message);
    return [];
  }
}

function formatDocuments(documents) {
  if (!documents || documents.length === 0) {
    return "未检索到相关片段。";
  }

  return documents
    .map(
      (item, i) =>
        `[片段 ${i + 1}]
章节: 第 ${item.chapter_num} 章
相似度: ${item.score.toFixed(4)}
内容: ${item.content}`,
    )
    .join("\n\n━━━━━\n\n");
}

function formatDocumentsForReasoning(documents, maxDocuments = 2, maxCharsPerDoc = 220) {
  if (!documents || documents.length === 0) {
    return "未检索到相关片段。";
  }

  return documents
    .slice(0, maxDocuments)
    .map(
      (item, i) =>
        `[片段 ${i + 1}]
章节: 第 ${item.chapter_num} 章
相似度: ${item.score.toFixed(4)}
内容: ${item.content.slice(0, maxCharsPerDoc)}`,
    )
    .join("\n\n━━━━━\n\n");
}

/**
 * 按 id 合并多跳检索结果；同 id 只保留更高 score 的那一条。
 * 合并后按 score 倒序排列，并只保留全局前 maxDocs 条。
 */
function mergeUnique(existingDocs, newDocs, maxDocs = TOP_K) {
  const map = new Map();

  for (const doc of [...existingDocs, ...newDocs]) {
    const key = String(doc.id);
    const prev = map.get(key);

    if (!prev || Number(doc.score) > Number(prev.score)) {
      map.set(key, doc);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, maxDocs);
}

function summarizeHopResults(hopResults) {
  if (!hopResults || hopResults.length === 0) {
    return "暂无前序检索结果。";
  }

  return hopResults
    .map(
      (item, i) => `步骤 ${i + 1}
原始子问题: ${item.originalSubQuestion}
独立检索问题: ${item.standaloneQuestion}
阶段结论: ${item.partialAnswer}`,
    )
    .join("\n\n");
}

async function streamAnswer(title, prompt) {
  process.stdout.write(`\n${title}\n`);
  let answer = "";
  try {
    const stream = await llm.stream(prompt);

    for await (const chunk of stream) {
      const text = typeof chunk.content === "string" ? chunk.content : "";
      if (!text) continue;
      answer += text;
      process.stdout.write(text);
    }
  } catch (error) {
    const fallback = `模型流式回答失败：${error.message}`;
    process.stdout.write(fallback);
    answer = fallback;
  }

  process.stdout.write("\n");
  return answer;
}

// ─────────────────────────────────────────────
// 构建节点
// ─────────────────────────────────────────────
const routeNode = async (state) => {
  console.log("【问题路由】正在判断问题类型...");

  try {
    const routeResult = await routerModel.invoke(`
你是《天龙八部》RAG 系统的路由器，只负责判断回答策略，不负责真正回答问题。

请根据用户问题决定 strategy：
- direct：问题非常简单，不依赖知识库检索也能安全回答
- retrieve：问题需要一次检索即可回答
- multihop：问题需要先确认一个中间事实，再基于该事实继续检索，属于多步推理/多跳检索问题

多跳检索示例：
- “段誉遇到的第一个神仙姐姐画像，是谁的弟子？”
- “乔峰误杀阿朱之前，阿朱假扮的是谁？”

用户问题：${state.question}
`);

    console.log(`【路由结果】${routeResult.strategy}（原因：${routeResult.reason}）`);

    return {
      question: state.question,
      k: state.k,
      strategy: routeResult.strategy,
      routeReason: routeResult.reason,
      subQuestions: [],
      nextSubIdx: 0,
      retrievalCount: 0,
      maxRetrievals: state.maxRetrievals,
      plannedNext: "generate",
      hopResults: [],
      documents: [],
    };
  } catch (error) {
    console.warn(`【路由结果】模型判断失败，默认走普通检索。原因：${error.message}`);
    return {
      question: state.question,
      k: state.k,
      strategy: "retrieve",
      routeReason: "路由模型调用失败，默认使用单次检索增强回答。",
      subQuestions: [],
      nextSubIdx: 0,
      retrievalCount: 0,
      maxRetrievals: state.maxRetrievals,
      plannedNext: "generate",
      hopResults: [],
      documents: [],
    };
  }
};

const directAnswerNode = async (state) => {
  const prompt = `你是一个专业的《天龙八部》小说助手。

用户问题：${state.question}

这是一个被判定为“可直接回答”的简单问题，请直接给出简洁、准确的回答。
如果你发现这个问题其实依赖剧情细节、章节内容或原文依据，请明确说明这类问题更适合先检索知识库再回答，不要编造。`;

  const answer = await streamAnswer("【AI 直接回答（流式）】", prompt);

  return {
    ...state,
    answer,
  };
};

const retrieveNode = async (state) => {
  const documents = await retrieveRelevantContent(state.question, state.k);
  return {
    ...state,
    documents,
  };
};

const decomposeNode = async (state) => {
  console.log("【多跳拆分】正在拆分子问题...");

  try {
    const decomposition = await decompositionModel.invoke(`
你是《天龙八部》多跳检索规划器。

请把下面这个复杂问题拆成 2 到 4 个有顺序依赖的子问题。
要求：
1. 子问题必须按求解顺序排列
2. 每个子问题都要足够清晰，便于去向量数据库检索
3. 不要直接回答原问题，只做拆分

用户问题：${state.question}
`);

    console.log("【多跳拆分结果】");
    decomposition.subQuestions.forEach((subQuestion, index) => {
      console.log(`  ${index + 1}. ${subQuestion}`);
    });

    return {
      ...state,
      subQuestions: decomposition.subQuestions,
      nextSubIdx: 0,
      retrievalCount: 0,
      plannedNext: "retrieve",
      routeReason: `${state.routeReason}；拆分依据：${decomposition.reasoning}`,
    };
  } catch (error) {
    console.warn(`【多跳拆分】失败，退回单次检索。原因：${error.message}`);
    return {
      ...state,
      strategy: "retrieve",
      subQuestions: [],
    };
  }
};

const multihopRetrieveNode = async (state) => {
  const subQuestions = state.subQuestions ?? [];
  const currentIdx = state.nextSubIdx ?? 0;
  const existingHopResults = state.hopResults ?? [];

  if (currentIdx >= subQuestions.length) {
    return {
      ...state,
      plannedNext: "generate",
    };
  }

  const subQuestion = subQuestions[currentIdx];
  console.log(`【多跳检索】步骤 ${currentIdx + 1}/${subQuestions.length}`);
  console.log(`原始子问题: ${subQuestion}`);

  let standaloneQuestion = subQuestion;

  if (existingHopResults.length > 0) {
    try {
      const rewriteResult = await rewriteModel.invoke(`
你是一个检索问题改写器。

请把当前子问题改写成适合直接向量检索的独立问题。
改写时要结合前序步骤已经得到的结论，把代词、省略指代补全。

原始总问题：${state.question}

前序步骤结论：
${summarizeHopResults(existingHopResults)}

当前子问题：${subQuestion}
`);
      standaloneQuestion = rewriteResult.standaloneQuestion;
    } catch (error) {
      console.warn(`子问题改写失败，继续使用原始子问题。原因：${error.message}`);
    }
  }

  console.log(`独立检索问题: ${standaloneQuestion}`);
  const documents = await retrieveRelevantContent(standaloneQuestion, state.k);
  const mergedDocuments = mergeUnique(state.documents ?? [], documents, state.k);
  console.log(`合并后保留片段数: ${mergedDocuments.length}`);

  const partialPrompt = `你是《天龙八部》检索助手。

请只根据以下检索片段，回答当前子问题，给出简洁、明确的阶段性结论。
如果证据不足，请明确写“证据不足”。

当前子问题：${subQuestion}
独立检索问题：${standaloneQuestion}

检索片段：
${formatDocumentsForReasoning(documents)}
`;

  let partialText = "";
  try {
    const partialAnswer = await llm.invoke(partialPrompt);
    partialText =
      typeof partialAnswer.content === "string"
        ? partialAnswer.content
        : String(partialAnswer.content ?? "");
  } catch (error) {
    const fallbackEvidence = documents[0]?.content?.slice(0, 120) ?? "无可用证据片段";
    partialText = `阶段性总结失败，先保留最相关证据：${fallbackEvidence}`;
    console.warn(`阶段结论生成失败，已回退为片段摘要。原因：${error.message}`);
  }

  console.log(`阶段结论: ${partialText}`);

  const hopResults = [
    ...existingHopResults,
    {
      originalSubQuestion: subQuestion,
      standaloneQuestion,
      partialAnswer: partialText,
      documents,
    },
  ];

  return {
    ...state,
    hopResults,
    nextSubIdx: currentIdx + 1,
    retrievalCount: (state.retrievalCount ?? 0) + 1,
    documents: mergedDocuments,
  };
};

const planNextStepNode = async (state) => {
  console.log("【多跳规划】正在判断是否继续检索...");

  const remaining = (state.subQuestions?.length ?? 0) - (state.nextSubIdx ?? 0);
  const reachedLimit = (state.retrievalCount ?? 0) >= (state.maxRetrievals ?? 0);

  if (remaining <= 0 || reachedLimit) {
    const reason = remaining <= 0 ? "子问题已经全部检索完毕。" : "已达到最大检索轮数限制。";
    console.log(`【多跳规划结果】generate（原因：${reason}）`);
    return {
      ...state,
      plannedNext: "generate",
    };
  }

  const prompt = `你是《天龙八部》多跳 RAG 规划器。

请根据当前的多跳检索进展，判断下一步是继续检索剩余子问题，还是直接进入最终回答。

用户原问题：${state.question}

全部子问题：
${(state.subQuestions ?? [])
  .map((subQuestion, index) => {
    if (index < (state.nextSubIdx ?? 0)) {
      return `${index + 1}. ${subQuestion}（已检索）`;
    }
    if (index === (state.nextSubIdx ?? 0)) {
      return `${index + 1}. ${subQuestion}（下一步待检索）`;
    }
    return `${index + 1}. ${subQuestion}（未检索）`;
  })
  .join("\n")}

已完成的阶段结论：
${summarizeHopResults(state.hopResults)}

当前已合并的关键片段：
${formatDocumentsForReasoning(state.documents, 3, 180)}

硬性规则：
1. 如果已经有足够信息直接回答原问题，输出 generate
2. 如果仍缺关键中间事实，并且还有未检索子问题，输出 retrieve
3. 不要跳过未检索子问题乱编答案`;

  try {
    const decision = await nextStepModel.invoke(prompt);
    console.log(`【多跳规划结果】${decision.nextAction}（原因：${decision.reason}）`);
    return {
      ...state,
      plannedNext: decision.nextAction,
    };
  } catch (error) {
    console.warn(`【多跳规划】失败，默认继续检索。原因：${error.message}`);
    return {
      ...state,
      plannedNext: "retrieve",
    };
  }
};

const generateNode = async (state) => {
  if (state.documents.length === 0 && state.hopResults.length === 0) {
    return {
      ...state,
      answer: "抱歉，我没有找到相关的《天龙八部》内容。",
    };
  }

  let prompt = "";
  let title = "【AI 检索增强回答（流式）】";

  if (state.strategy === "multihop") {
    title = "【AI 多跳检索回答（流式）】";
    prompt = `你是一个专业的《天龙八部》小说助手。现在你已经完成了多步检索，请综合每一步结论与证据回答最终问题。

用户原问题：${state.question}

全局合并后的高相关片段：
${formatDocuments(state.documents)}

多步检索过程：
${state.hopResults
  .map(
    (hop, index) => `步骤 ${index + 1}
原始子问题：${hop.originalSubQuestion}
独立检索问题：${hop.standaloneQuestion}
阶段结论：${hop.partialAnswer}
证据片段：
${formatDocuments(hop.documents)}`,
  )
  .join("\n\n====================\n\n")}

回答要求：
1. 最终回答要直接回答原问题
2. 明确体现关键中间推理链条
3. 如果某一步证据不足，要如实说明
4. 不要编造未检索到的剧情细节`;
  } else {
    prompt = `你是一个专业的《天龙八部》小说助手。基于检索到的小说片段回答问题，用准确、详细的语言。

请根据以下《天龙八部》小说片段内容回答问题：
${formatDocuments(state.documents)}

用户问题: ${state.question}

回答要求：
1. 如果片段中有相关信息，请结合小说内容给出详细、准确的回答
2. 可以综合多个片段的内容，提供完整的答案
3. 如果片段中没有足够信息，请如实说明，不要编造
4. 回答要符合小说的情节和人物设定
5. 可以引用片段中的关键信息来支持你的回答`;
  }

  const answer = await streamAnswer(title, prompt);

  return {
    ...state,
    answer,
  };
};

// ─────────────────────────────────────────────
// 构建 LangGraph 图
// ─────────────────────────────────────────────
const graph = new StateGraph(StateAnnotation)
  .addNode("router", routeNode)
  .addNode("direct_answer", directAnswerNode)
  .addNode("retrieve", retrieveNode)
  .addNode("decompose", decomposeNode)
  .addNode("multihop_retrieve", multihopRetrieveNode)
  .addNode("plan_next_step", planNextStepNode)
  .addNode("generate", generateNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", (state) => state.strategy, {
    direct: "direct_answer",
    retrieve: "retrieve",
    multihop: "decompose",
  })
  .addConditionalEdges("decompose", (state) => state.strategy, {
    retrieve: "retrieve",
    multihop: "multihop_retrieve",
  })
  .addEdge("direct_answer", END)
  .addEdge("retrieve", "generate")
  .addEdge("multihop_retrieve", "plan_next_step")
  .addConditionalEdges("plan_next_step", (state) => state.plannedNext, {
    retrieve: "multihop_retrieve",
    generate: "generate",
  })
  .addEdge("generate", END)
  .compile();

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────
async function main() {
  const question =
    process.argv[2] ?? "段誉遇到的第一个神仙姐姐画像，是谁的弟子？";
  const kArg = Number(process.argv[3]);
  const maxRetrievalsArg = Number(process.argv[4]);
  const maxRetrievals = Number.isFinite(maxRetrievalsArg) && maxRetrievalsArg >= 1
    ? Math.floor(maxRetrievalsArg)
    : DEFAULT_MAX_RETRIEVALS;

  const drawable = await graph.getGraphAsync();
  const mermaid = drawable.drawMermaid({ withStyles: true });
  console.log(mermaid);

  console.log("=".repeat(80));
  console.log(`问题: ${question}`);
  console.log(`每轮 Top-K: ${Number.isFinite(kArg) ? kArg : TOP_K}；多跳最大检索轮数: ${maxRetrievals}`);
  console.log("=".repeat(80));

  const result = await graph.invoke({
    question,
    k: Number.isFinite(kArg) ? kArg : TOP_K,
    strategy: "retrieve",
    routeReason: "",
    subQuestions: [],
    nextSubIdx: 0,
    retrievalCount: 0,
    maxRetrievals,
    plannedNext: "generate",
    hopResults: [],
    documents: [],
    answer: "",
  });

  console.log("\n【路由摘要】");
  console.log(`策略: ${result.strategy}`);
  console.log(`原因: ${result.routeReason || "无"}`);

  if (result.strategy === "retrieve") {
    console.log("\n【检索相关内容】");
    if (result.documents.length === 0) {
      console.log("未找到相关内容");
    } else {
      result.documents.forEach((item, i) => {
        console.log(`\n[片段 ${i + 1}] 相似度: ${item.score.toFixed(4)}`);
        console.log(`书籍: ${item.book_id}`);
        console.log(`章节: 第 ${item.chapter_num} 章`);
        console.log(`片段索引: ${item.index}`);
        console.log(
          `内容: ${item.content.substring(0, 200)}${item.content.length > 200 ? "..." : ""}`,
        );
      });
    }
  }

  if (result.strategy === "multihop") {
    console.log("\n【多跳检索摘要】");
    if (result.hopResults.length === 0) {
      console.log("未生成多跳结果");
    } else {
      console.log(`检索轮数: ${result.retrievalCount} / ${result.maxRetrievals}`);
      result.hopResults.forEach((hop, index) => {
        console.log(`\n步骤 ${index + 1}`);
        console.log(`原始子问题: ${hop.originalSubQuestion}`);
        console.log(`独立检索问题: ${hop.standaloneQuestion}`);
        console.log(`阶段结论: ${hop.partialAnswer}`);
      });
    }
  }

  if (!result.answer) {
    console.log("\n【AI 回答】");
    console.log("模型未返回内容。");
  }
}

main().catch((error) => {
  console.error("程序运行失败:", error);
  process.exit(1);
});
