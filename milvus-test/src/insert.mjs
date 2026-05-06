import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { MilvusClient, DataType, MetricType, IndexType } from '@zilliz/milvus2-sdk-node';
import { OpenAIEmbeddings } from "@langchain/openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 依次加载：项目根目录 .env、milvus-test/.env（后者覆盖前者，便于子目录单独配置）
dotenv.config({ path: join(__dirname, "..", "..", ".env") });
dotenv.config({ path: join(__dirname, "..", ".env"), override: true });

// 避免全局 NODE_TLS_REJECT_UNAUTHORIZED=0 导致 TLS 行为异常（由上层终端注入时常见）
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

if (!process.env.DASHSCOPE_API_KEY) {
  console.error("错误: 未设置 DASHSCOPE_API_KEY。请在 milvus-test/.env 或项目根 .env 中配置。");
  process.exit(1);
}
if (!process.env.OPENAI_BASE_URL) {
  console.error("错误: 未设置 OPENAI_BASE_URL（DashScope 兼容模式地址）。");
  process.exit(1);
}
if (!process.env.EMBEDDINGS_MODEL_NAME) {
  console.error("错误: 未设置 EMBEDDINGS_MODEL_NAME（例如 text-embedding-v3）。");
  process.exit(1);
}

const COLLECTION_NAME = 'ai_diary';
const VECTOR_DIM = 1024;

// 公网抖动时适当拉长超时；具体毫秒可通过环境变量覆盖
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) || 180_000;
const EMBED_MAX_ATTEMPTS = Number(process.env.EMBED_MAX_ATTEMPTS) || 4;

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.DASHSCOPE_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  timeout: EMBED_TIMEOUT_MS,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL
  },
  dimensions: VECTOR_DIM
});

const client = new MilvusClient({
  address: 'localhost:19530'
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的向量生成：应对公网偶发超时，不改变向量结果语义
 */
async function getEmbedding(text) {
  let lastError;
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt++) {
    try {
      return await embeddings.embedQuery(text);
    } catch (err) {
      lastError = err;
      const message = err?.message ?? String(err);
      console.warn(`  向量请求失败（第 ${attempt}/${EMBED_MAX_ATTEMPTS} 次）: ${message}`);
      if (attempt < EMBED_MAX_ATTEMPTS) {
        const waitMs = 2000 * attempt;
        console.warn(`  ${waitMs}ms 后重试...`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

async function main() {
  try {
    console.log('Connecting to Milvus...');
    await client.connectPromise;
    console.log('✓ Connected\n');

    // 创建集合
    console.log('Creating collection...');
    await client.createCollection({
      collection_name: COLLECTION_NAME,
      fields: [
        { name: 'id', data_type: DataType.VarChar, max_length: 50, is_primary_key: true },
        { name: 'vector', data_type: DataType.FloatVector, dim: VECTOR_DIM },
        { name: 'content', data_type: DataType.VarChar, max_length: 5000 },
        { name: 'date', data_type: DataType.VarChar, max_length: 50 },
        { name: 'mood', data_type: DataType.VarChar, max_length: 50 },
        { name: 'tags', data_type: DataType.Array, element_type: DataType.VarChar, max_capacity: 10, max_length: 50 }
      ]
    });
    console.log('Collection created');

    // 创建索引
    console.log('\nCreating index...');
    await client.createIndex({
      collection_name: COLLECTION_NAME,
      field_name: 'vector',
      index_type: IndexType.IVF_FLAT,
      metric_type: MetricType.COSINE,
      params: { nlist: 1024 }
    });
    console.log('Index created');

    // 加载集合
    console.log('\nLoading collection...');
    await client.loadCollection({ collection_name: COLLECTION_NAME });
    console.log('Collection loaded');

    // 插入日记数据
    console.log('\nInserting diary entries...');
    const diaryContents = [
      {
        id: 'diary_001',
        content: '今天天气很好，去公园散步了，心情愉快。看到了很多花开了，春天真美好。',
        date: '2026-01-10',
        mood: 'happy',
        tags: ['生活', '散步']
      },
      {
        id: 'diary_002',
        content: '今天工作很忙，完成了一个重要的项目里程碑。团队合作很愉快，感觉很有成就感。',
        date: '2026-01-11',
        mood: 'excited',
        tags: ['工作', '成就']
      },
      {
        id: 'diary_003',
        content: '周末和朋友去爬山，天气很好，心情也很放松。享受大自然的感觉真好。',
        date: '2026-01-12',
        mood: 'relaxed',
        tags: ['户外', '朋友']
      },
      {
        id: 'diary_004',
        content: '今天学习了 Milvus 向量数据库，感觉很有意思。向量搜索技术真的很强大。',
        date: '2026-01-12',
        mood: 'curious',
        tags: ['学习', '技术']
      },
      {
        id: 'diary_005',
        content: '晚上做了一顿丰盛的晚餐，尝试了新菜谱。家人都说很好吃，很有成就感。',
        date: '2026-01-13',
        mood: 'proud',
        tags: ['美食', '家庭']
      }
    ];

    console.log('Generating embeddings...');
    // 串行生成向量：虽然更慢，但在网络不稳定时成功率更高
    const diaryData = [];
    for (let i = 0; i < diaryContents.length; i++) {
      const diary = diaryContents[i];
      const startTime = Date.now();
      console.log(`  [${i + 1}/${diaryContents.length}] 正在为 ${diary.id} 生成向量...`);
      const vector = await getEmbedding(diary.content);
      const elapsedMs = Date.now() - startTime;
      console.log(`  [${i + 1}/${diaryContents.length}] ✓ 向量生成完成，耗时 ${elapsedMs}ms`);
      diaryData.push({
        ...diary,
        vector
      });
    }

    const insertResult = await client.insert({
      collection_name: COLLECTION_NAME,
      data: diaryData
    });
    console.log(`✓ Inserted ${insertResult.insert_cnt} records\n`);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
