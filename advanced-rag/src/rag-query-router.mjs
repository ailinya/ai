import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { z } from "zod";
// 这个文件解决了让模型根据问题类型选择检索策略，简单问题直接回答，复杂问题才走完整检索这个就是加一个节点来做判断，是直接回答，还是先检索向量数据库再回答
const TOP_K = 5;
const COLLECTION_NAME = "ebook_collection";

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
  route: Annotation({
    reducer: (_prev, next) => next,
    default: () => "retrieve",
  }),
  routeReason: Annotation({
    reducer: (_prev, next) => next,
    default: () => "",
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

const RouteSchema = z.object({
  strategy: z.enum(["direct", "retrieve"]),
  reason: z.string(),
});

const routerModel = llm.withStructuredOutput(RouteSchema);

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

async function streamAnswer(title, prompt) {
  process.stdout.write(`\n${title}\n`);
  let answer = "";
  const stream = await llm.stream(prompt);

  for await (const chunk of stream) {
    const text = typeof chunk.content === "string" ? chunk.content : "";
    if (!text) continue;
    answer += text;
    process.stdout.write(text);
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
- direct：问题很简单，不依赖向量库检索也能直接回答
- retrieve：问题涉及《天龙八部》的剧情、人物关系、结局、章节细节、证据引用，或需要依据知识库内容回答

用户问题：${state.question}
`);

    console.log(`【路由结果】${routeResult.strategy}（原因：${routeResult.reason}）`);

    return {
      question: state.question,
      k: state.k,
      route: routeResult.strategy,
      routeReason: routeResult.reason,
      documents: [],
    };
  } catch (error) {
    console.warn(`【路由结果】模型判断失败，默认走检索。原因：${error.message}`);
    return {
      question: state.question,
      k: state.k,
      route: "retrieve",
      routeReason: "路由模型调用失败，默认使用更稳妥的检索增强回答。",
      documents: [],
    };
  }
};

const directAnswerNode = async (state) => {
  const prompt = `你是一个专业的《天龙八部》小说助手。

用户问题：${state.question}

这是一个被判定为“可直接回答”的简单问题，请直接给出简洁、准确的回答。
如果你发现这个问题其实依赖具体剧情细节、章节内容或原文依据，请明确说明这类问题更适合先检索知识库再回答，不要编造。`;

  const answer = await streamAnswer("【AI 直接回答（流式）】", prompt);

  return {
    question: state.question,
    k: state.k,
    route: state.route,
    routeReason: state.routeReason,
    documents: state.documents,
    answer,
  };
};

const retrieveNode = async (state) => {
  const documents = await retrieveRelevantContent(state.question, state.k);
  return {
    question: state.question,
    k: state.k,
    route: state.route,
    routeReason: state.routeReason,
    documents,
  };
};

const generateNode = async (state) => {
  if (state.documents.length === 0) {
    return {
      question: state.question,
      k: state.k,
      route: state.route,
      routeReason: state.routeReason,
      documents: state.documents,
      answer: "抱歉，我没有找到相关的《天龙八部》内容。",
    };
  }

  const context = state.documents
    .map(
      (item, i) =>
        `[片段 ${i + 1}]
章节: 第 ${item.chapter_num} 章
内容: ${item.content}`,
    )
    .join("\n\n━━━━━\n\n");

  const prompt = `你是一个专业的《天龙八部》小说助手。基于检索到的小说片段回答问题，用准确、详细的语言。

请根据以下《天龙八部》小说片段内容回答问题：
${context}

用户问题: ${state.question}

回答要求：
1. 如果片段中有相关信息，请结合小说内容给出详细、准确的回答
2. 可以综合多个片段的内容，提供完整的答案
3. 如果片段中没有足够信息，请如实说明，不要编造
4. 回答要符合小说的情节和人物设定
5. 可以引用片段中的关键信息来支持你的回答`;

  const answer = await streamAnswer("【AI 检索增强回答（流式）】", prompt);

  return {
    question: state.question,
    k: state.k,
    route: state.route,
    routeReason: state.routeReason,
    documents: state.documents,
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
  .addNode("generate", generateNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", (state) => state.route, {
    direct: "direct_answer",
    retrieve: "retrieve",
  })
  .addEdge("direct_answer", END)
  .addEdge("retrieve", "generate")
  .addEdge("generate", END)
  .compile();

// ─────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────
async function main() {
  const question = process.argv[2] ?? "天龙八部是谁导演的？";
  const kArg = Number(process.argv[3]);

  const drawable = await graph.getGraphAsync();
  const mermaid = drawable.drawMermaid({ withStyles: true });
  console.log(mermaid);

  console.log("=".repeat(80));
  console.log(`问题: ${question}`);
  console.log("=".repeat(80));

  const result = await graph.invoke({
    question,
    k: Number.isFinite(kArg) ? kArg : TOP_K,
    route: "retrieve",
    routeReason: "",
    documents: [],
    answer: "",
  });

  console.log("\n【路由摘要】");
  console.log(`策略: ${result.route}`);
  console.log(`原因: ${result.routeReason || "无"}`);

  if (result.route === "retrieve") {
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

  if (!result.answer) {
    console.log("\n【AI 回答】");
    console.log("模型未返回内容。");
  }
}

main().catch((error) => {
  console.error("程序运行失败:", error);
  process.exit(1);
});
