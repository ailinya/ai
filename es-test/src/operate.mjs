import 'dotenv/config';
import { Client } from '@elastic/elasticsearch';
import { Document } from '@langchain/core/documents';
import { DashscopeQwenRerankCompressor } from './rerank/dashscope-rerank.mjs';

const client = new Client({
  node: 'http://localhost:9200'
});

const INDEX_NAME = 'travel_journal';

async function createDocument() {
  const now = new Date().toISOString();
  const res = await client.index({
    index: INDEX_NAME,
    document: {
      note_title: '夜跑复盘',
      note_body: '今天夜跑 5 公里，配速稳定，结束后做了拉伸。',
      tags: ['运动', '夜跑'],
      mood: 'focused',
      priority: 2,
      created_at: now,
      updated_at: now
    },
    refresh: true
  });

  console.log('✅ 新增成功，ID =', res._id);
  return res._id;
}

async function getDocument(docId) {
  const res = await client.get({
    index: INDEX_NAME,
    id: docId
  });
  console.log('📖 查询结果:', res._source);
}

async function updateDocument(docId) {
  await client.update({
    index: INDEX_NAME,
    id: docId,
    doc: {
      note_body: '今天夜跑 6 公里，状态不错，拉伸后恢复很快。',
      tags: ['运动', '夜跑', '训练'],
      updated_at: new Date().toISOString()
    },
    refresh: true
  });
  console.log('🔄 更新成功');
}

async function searchDocuments() {
  const res = await client.search({
    index: INDEX_NAME,
    query: {
      match: {
        note_body: {
          query: '慢跑以及骑行的数据',
          analyzer: 'ik_smart'
        }
      }
    }
  });

  const rows = res.hits.hits.map((item) => ({
    id: item._id,
    ...item._source
  }));
  console.log('🔍 搜索结果:', rows);
}

async function deleteDocument(docId) {
  await client.delete({
    index: INDEX_NAME,
    id: docId,
    refresh: true
  });
  console.log('🗑️ 删除成功');
}

// 演示：ES 召回 -> qwen3-rerank 重排序
// 复用现有 match 召回（适当放大 size 给 rerank 留候选），不修改原 searchDocuments
async function searchAndRerank(queryText = '慢跑以及骑行的数据', topN = 5) {
  const res = await client.search({
    index: INDEX_NAME,
    size: 10,
    query: {
      match: {
        note_body: {
          query: queryText,
          analyzer: 'ik_smart'
        }
      }
    }
  });

  const docs = res.hits.hits.map((item) => {
    const source = item._source ?? {};
    const title = source.note_title ?? '';
    const body = source.note_body ?? '';
    return new Document({
      pageContent: title ? `${title}\n${body}` : body,
      metadata: { id: item._id, es_score: item._score, ...source }
    });
  });

  if (!docs.length) {
    console.log('🔍 ES 未召回任何文档');
    return [];
  }

  const compressor = new DashscopeQwenRerankCompressor({ topN });
  const reranked = await compressor.compressDocuments(docs, queryText);

  console.log(`🔁 重排后 Top ${reranked.length}：`);
  reranked.forEach((doc, i) => {
    const { dashscope_rerank_score, dashscope_rerank_index, id, es_score } = doc.metadata;
    console.log(
      `#${i + 1} score=${dashscope_rerank_score?.toFixed?.(4) ?? dashscope_rerank_score} ` +
        `(原序 #${dashscope_rerank_index} es=${es_score} id=${id})\n` +
        `   ${doc.pageContent.replace(/\n/g, ' ')}`
    );
  });
  return reranked;
}

async function run() {
  // const docId = await createDocument();
  // await getDocument(docId);
  // console.log('docId', docId);
  const docId = 'gqWuAZ4BErDTtd06dA6o';
  // await updateDocument(docId);
  // await getDocument(docId);
  // await searchDocuments();
  // await searchAndRerank('慢跑以及骑行的数据');

  await deleteDocument(docId);
}

run().catch((err) => {
  console.error('❌ 操作阶段失败:', err);
  process.exit(1);
});
