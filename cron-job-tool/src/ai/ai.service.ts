import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { StructuredTool } from '@langchain/core/tools';

/**
 * 下面是最初版本的内联工具定义，只是保留做参考，不再实际使用。
 *
 * const database = {
 *   users: {
 *     '001': { id: '001', name: '张三', email: 'zhangsan@example.com', role: 'admin' },
 *     '002': { id: '002', name: '李四', email: 'lisi@example.com', role: 'user' },
 *     '003': { id: '003', name: '王五', email: 'wangwu@example.com', role: 'user' },
 *   },
 * };
 *
 * const queryUserArgsSchema = z.object({
 *   userId: z.string().describe('用户 ID，例如: 001, 002, 003'),
 * });
 *
 * type QueryUserArgs = {
 *   userId: string;
 * };
 *
 * const queryUserTool = tool(
 *   async ({ userId }: QueryUserArgs) => {
 *     const user = database.users[userId];
 *
 *     if (!user) {
 *       return `用户 ID ${userId} 不存在。可用的 ID: 001, 002, 003`;
 *     }
 *
 *     return `用户信息：\n- ID: ${user.id}\n- 姓名: ${user.name}\n- 邮箱: ${user.email}\n- 角色: ${user.role}`;
 *   },
 *   {
 *     name: 'query_user',
 *     description:
 *       '查询数据库中的用户信息。输入用户 ID，返回该用户的详细信息（姓名、邮箱、角色）。',
 *     schema: queryUserArgsSchema,
 *   },
 * );
 */

@Injectable()
export class AiService {
  private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;

  constructor(
    @Inject('CHAT_MODEL') model: ChatOpenAI,
    @Inject('QUERY_USER_TOOL') private readonly queryUserTool: StructuredTool,
    @Inject('SEND_MAIL_TOOL') private readonly sendMailTool: StructuredTool,
    @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: StructuredTool,
  ) {
    this.modelWithTools = model.bindTools([
      this.queryUserTool,
      this.sendMailTool,
      this.webSearchTool,
    ]);
  }

  async runChain(query: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(
        '你是一个智能助手，可以在需要时调用工具（如 query_user 查询用户信息、send_mail 发送邮件、web_search 进行互联网搜索），再用结果回答用户的问题。',
      ),
      new HumanMessage(query),
    ];

    while (true) {
      const aiMessage = await this.modelWithTools.invoke(messages);
      messages.push(aiMessage);

      const toolCalls = aiMessage.tool_calls ?? [];

      // 没有要调用的工具，直接把回答返回给调用方
      if (!toolCalls.length) {
        return aiMessage.content as string;
      }

      // 依次执行本轮需要调用的所有工具
      for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id || '';
        const toolName = toolCall.name;

        if (toolName === 'query_user') {
          const result = (await this.queryUserTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'send_mail') {
          const result = (await this.sendMailTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'web_search') {
          const result = (await this.webSearchTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        }
      }
    }
  }

  async *runChainStream(query: string): AsyncIterable<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(
        '你是一个智能助手，可以在需要时调用工具（如 query_user）来查询用户信息，再用结果回答用户的问题。',
      ),
      new HumanMessage(query),
    ];

    while (true) {
      // 一轮对话：先让模型思考并（可能）提出工具调用
      const stream = await this.modelWithTools.stream(messages);

      let fullAIMessage: AIMessageChunk | null = null;

      //   for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
      //     // 使用 concat 持续拼接，得到本轮完整的 AIMessageChunk
      //     fullAIMessage = fullAIMessage ? fullAIMessage.concat(chunk) : chunk;

      //     const hasToolCallChunk =
      //       !!fullAIMessage.tool_call_chunks &&
      //       fullAIMessage.tool_call_chunks.length > 0;

      //     // 只要当前轮次还没出现 tool 调用的 chunk，就可以把文本内容流式往外推
      //     if (!hasToolCallChunk && chunk.content) {
      //         yield chunk.content as string
      //     }
      //   }
      for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
        fullAIMessage = fullAIMessage ? fullAIMessage.concat(chunk) : chunk;

        // 只要 fullAIMessage 里一旦出现了任何工具调用的影子
        const isToolCalling = (fullAIMessage.tool_call_chunks?.length ?? 0) > 0;

        // 只有在确定不是工具调用时，才 yield content
        if (!isToolCalling && chunk.content) {
          yield chunk.content as string;
        }
      }

      if (!fullAIMessage) {
        return;
      }

      messages.push(fullAIMessage);

      const toolCalls = fullAIMessage.tool_calls ?? [];

      // 没有工具调用：说明这一轮就是最终回答，已经在上面的 for-await 中流完了，可以结束
      if (!toolCalls.length) {
        return;
      }

      // 有工具调用：本轮我们不再额外输出内容，而是执行工具，生成 ToolMessage，进入下一轮
      for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id || '';
        const toolName = toolCall.name;

        if (toolName === 'query_user') {
          const result = (await this.queryUserTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'send_mail') {
          const result = (await this.sendMailTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        } else if (toolName === 'web_search') {
          const result = (await this.webSearchTool.invoke(
            toolCall.args,
          )) as string;

          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: result,
            }),
          );
        }
      }
    }
  }
}
