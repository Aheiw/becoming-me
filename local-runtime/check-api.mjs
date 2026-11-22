export async function probeModel() {
  try {
    const { generateInterviewResponse } = await import('../packages/server/src/llm/provider.ts');
    const result = await generateInterviewResponse(
      '这是一次虚构的连通性测试，不涉及真实个人资料。用简体中文问一个关于虚构人物兴趣的问题，并遵守结构化输出格式。',
      [{ role: 'user', content: '虚构人物周末做纸飞机。' }],
    );
    console.log(JSON.stringify({ ok: Boolean(result.response), chinese: /\p{Script=Han}/u.test(result.response) }));
  } catch (error) {
    // API errors may capture request headers and messages; never print the full object.
    console.error(JSON.stringify({ ok: false, type: error?.name, status: error?.statusCode ?? error?.cause?.statusCode }));
    process.exitCode = 1;
  }
}
